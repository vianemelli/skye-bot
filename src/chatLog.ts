import { readFileSync, existsSync } from "fs";
import { writeFile, mkdir, access } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { askSkye, type ApiCredentials } from "./openai.js";
import { log } from "./utils/log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const SUMMARY_FILE = join(DATA_DIR, "chat-summaries.json");

const MAX_BUFFER = 50;
const RECENT_COUNT = 20;
const SUMMARIZE_INTERVAL = 10;

export interface LogEntry {
  sender: string;
  timestamp: string;
  type: string;
  content: string;
  replyTo?: string;
}

// In-memory ring buffers keyed by chatId
const logs = new Map<number, LogEntry[]>();
const counters = new Map<number, number>();
const summaries = new Map<number, string>();
const chatTitles = new Map<number, string>();

// Load persisted summaries on import
if (existsSync(SUMMARY_FILE)) {
  try {
    const raw = JSON.parse(readFileSync(SUMMARY_FILE, "utf-8"));
    for (const [key, value] of Object.entries(raw)) {
      summaries.set(Number(key), value as string);
    }
  } catch {
    // Corrupted file — start fresh
  }
}

async function persistSummaries(): Promise<void> {
  try {
    await access(DATA_DIR);
  } catch {
    await mkdir(DATA_DIR, { recursive: true });
  }
  const obj: Record<string, string> = {};
  for (const [k, v] of summaries) obj[String(k)] = v;
  await writeFile(SUMMARY_FILE, JSON.stringify(obj, null, 2));
}

export function formatLogEntry(entry: LogEntry): string {
  const time = entry.timestamp;
  const reply = entry.replyTo ? ` (replying to ${entry.replyTo})` : "";
  const typeTag = entry.type !== "text" ? `[${entry.type}] ` : "";
  return `[${time}] ${entry.sender}${reply}: ${typeTag}${entry.content}`;
}

/**
 * Push a message to the buffer. Returns true if summarization is due.
 */
export function logMessage(chatId: number, entry: LogEntry, chatTitle?: string): boolean {
  if (chatTitle) chatTitles.set(chatId, chatTitle);

  if (!logs.has(chatId)) logs.set(chatId, []);
  const buf = logs.get(chatId)!;
  buf.push(entry);
  if (buf.length > MAX_BUFFER) buf.shift();

  const count = (counters.get(chatId) ?? 0) + 1;
  counters.set(chatId, count);

  return count >= SUMMARIZE_INTERVAL;
}

/**
 * Returns the older portion of the buffer (everything before the last 20)
 * for feeding into the summarizer.
 */
export function getOlderEntries(chatId: number): LogEntry[] {
  const buf = logs.get(chatId);
  if (!buf) return [];
  const cutoff = Math.max(0, buf.length - RECENT_COUNT);
  return buf.slice(0, cutoff);
}

/**
 * Returns chat context for the system prompt, or undefined if no log exists.
 */
export function getChatContext(
  chatId: number
): { chatTitle: string; summary: string; recentLog: string } | undefined {
  const buf = logs.get(chatId);
  if (!buf || buf.length === 0) return undefined;

  const title = chatTitles.get(chatId) ?? "Unknown Chat";
  const summary = summaries.get(chatId) ?? "";

  const recent = buf.slice(-RECENT_COUNT);
  const recentLog = recent.map(formatLogEntry).join("\n");

  return { chatTitle: title, summary, recentLog };
}

/**
 * Store a summary and reset the counter. Persists to disk.
 */
export async function setSummary(chatId: number, summary: string): Promise<void> {
  summaries.set(chatId, summary);
  counters.set(chatId, 0);
  await persistSummaries();
}

/**
 * Summarize older entries via askSkye and store the result.
 */
export async function summarizeChat(chatId: number, creds?: ApiCredentials): Promise<void> {
  const older = getOlderEntries(chatId);
  if (older.length === 0) {
    // Nothing to summarize, just reset counter
    counters.set(chatId, 0);
    return;
  }

  const formatted = older.map(formatLogEntry).join("\n");
  const messages = [
    {
      role: "system" as const,
      content:
        "You are a concise summarizer. Given a log of group chat messages, produce a brief summary noting: key participants, topics discussed, any media or files exchanged, and approximate timeline. Keep it under 200 words. Output only the summary, no preamble.",
    },
    {
      role: "user" as const,
      content: formatted,
    },
  ];

  try {
    const res = await askSkye(messages, undefined, creds);
    const text = res.choices[0]?.message?.content;
    if (text) {
      await setSummary(chatId, text);
      log.info(`Chat ${chatId}: summarized ${older.length} older messages`);
    }
  } catch (e: any) {
    log.err(`Chat ${chatId}: summarization failed: ${e?.message || e}`);
    // Reset counter so we retry next interval
    counters.set(chatId, 0);
  }
}

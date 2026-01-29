import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export interface ChatApiConfig {
  apiKey?: string;
  baseUrl?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const DATA_FILE = join(DATA_DIR, "chat-configs.json");

const store = new Map<number, ChatApiConfig>();

// Load from disk on import
if (existsSync(DATA_FILE)) {
  try {
    const raw = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
    for (const [key, value] of Object.entries(raw)) {
      store.set(Number(key), value as ChatApiConfig);
    }
  } catch {
    // Corrupted file — start fresh
  }
}

function persist() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const obj: Record<string, ChatApiConfig> = {};
  for (const [k, v] of store) obj[String(k)] = v;
  writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
}

export function getChatConfig(chatId: number): ChatApiConfig {
  return store.get(chatId) ?? {};
}

export function setChatApiKey(chatId: number, apiKey: string): void {
  const cfg = store.get(chatId) ?? {};
  cfg.apiKey = apiKey;
  store.set(chatId, cfg);
  persist();
}

export function setChatBaseUrl(chatId: number, baseUrl: string): void {
  const cfg = store.get(chatId) ?? {};
  cfg.baseUrl = baseUrl;
  store.set(chatId, cfg);
  persist();
}

export function resetChatApiKey(chatId: number): void {
  const cfg = store.get(chatId);
  if (!cfg) return;
  delete cfg.apiKey;
  if (!cfg.apiKey && !cfg.baseUrl) store.delete(chatId);
  persist();
}

export function resetChatBaseUrl(chatId: number): void {
  const cfg = store.get(chatId);
  if (!cfg) return;
  delete cfg.baseUrl;
  if (!cfg.apiKey && !cfg.baseUrl) store.delete(chatId);
  persist();
}

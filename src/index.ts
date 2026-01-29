import { Bot } from "grammy";
import { BOT_TOKEN } from "./config.js";
import { cleanMd } from "./utils/markdown.js";
import { askSkye } from "./openai.js";
import { log } from "./utils/log.js";
import { buildContext } from "./contextBuilder.js";
import { SYSTEM } from "./prompt.js";

const bot = new Bot(BOT_TOKEN);

// Global error handler to prevent crashes
bot.catch((err) => {
  const msg =
    (err as any)?.error?.message || (err as Error).message || "Unknown error";
  log.err(`Bot error: ${msg}`);
});

// Advertise bot commands
void bot.api.setMyCommands([
  { command: "reset", description: "Reset conversation context" },
]);

// Simple rolling memory per chat (stores Chat Completion message objects)
const memory = new Map<number, Array<any>>();

function storeUserText(ctx: any) {
  const id = ctx.chat.id;
  if (!memory.has(id)) memory.set(id, []);
  const list = memory.get(id)!;
  list.push({ role: "user", content: ctx.message.text || "" });
  // Limit history
  if (list.length > 15) list.shift();
}

function storeUserImage(ctx: any, parts: any[]) {
  const id = ctx.chat.id;
  if (!memory.has(id)) memory.set(id, []);
  const list = memory.get(id)!;
  list.push({ role: "user", content: parts });
  if (list.length > 15) list.shift();
}

function storeAssistantText(ctx: any, text: string) {
  const id = ctx.chat.id;
  if (!memory.has(id)) memory.set(id, []);
  const list = memory.get(id)!;
  list.push({ role: "assistant", content: text });
  if (list.length > 15) list.shift();
}

// Rate limiting (very light): 1 request per 2s per chat
const lastCall = new Map<number, number>();
function canRespond(chatId: number) {
  const now = Date.now();
  const prev = lastCall.get(chatId) ?? 0;
  if (now - prev < 2000) return false;
  lastCall.set(chatId, now);
  return true;
}

bot.on("message:text", async (ctx) => {
  const isPM = ctx.chat.type === "private";
  const mention = ctx.message.text.includes(`@${ctx.me.username}`);

  if (!isPM && !mention) return; // groups: only when tagged

  storeUserText(ctx);
  if (!canRespond(ctx.chat.id)) return;

  log.info(`Incoming from ${ctx.chat.id}`);

  const history = memory.get(ctx.chat.id) || [];
  const msgs = [SYSTEM, ...buildContext(history)];

  const response = await askSkye(msgs);
  const text = cleanMd(response.choices[0].message.content || "");

  await ctx.reply(text, { reply_to_message_id: ctx.message.message_id });
  storeAssistantText(ctx, text);
});

// reset context
bot.command("reset", async (ctx) => {
  memory.delete(ctx.chat.id);
  await ctx.reply("Context reset.");
});

// photo input
bot.on("message:photo", async (ctx) => {
  log.info(`Photo from ${ctx.chat.id}`);
  if (!canRespond(ctx.chat.id)) return;

  try {
    const isPM = ctx.chat.type === "private";
    const captionRaw = ctx.message.caption?.trim() || "";
    const hasMention = captionRaw.includes(`@${ctx.me.username}`);
    // In groups/supergroups, only respond if caption exists AND mentions the bot
    if (!isPM) {
      if (!captionRaw || !hasMention) return;
    }

    const file = await ctx.api.getFile(ctx.message.photo.pop()!.file_id);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    const parts: any[] = [];
    if (captionRaw) parts.push({ type: "text", text: captionRaw });
    parts.push({ type: "image_url", image_url: { url } });

    // Store the image message in memory so future turns see it
    storeUserImage(ctx, parts);
    const history = memory.get(ctx.chat.id) || [];
    const msgs = [SYSTEM, ...buildContext(history)];

    const response = await askSkye(msgs);
    const text = cleanMd(response.choices[0].message.content || "");

    await ctx.reply(text, { reply_to_message_id: ctx.message.message_id });
    storeAssistantText(ctx, text);
  } catch (e: any) {
    log.err(`Image handler failed: ${e?.message || e}`);
  }
});

bot.start({ drop_pending_updates: true });
log.info("Skye is alive");

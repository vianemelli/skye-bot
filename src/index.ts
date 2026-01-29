import { Bot, InputFile, Context, NextFunction } from "grammy";
import { BOT_TOKEN, ALLOWED_IDS, BASE_URL } from "./config.js";
import { cleanMd } from "./utils/markdown.js";
import {
  askSkyeStream,
  checkModelCapabilities,
  generateImage,
  modelSupportsImages,
  ApiCredentials,
} from "./openai.js";
import { log } from "./utils/log.js";
import { buildContext } from "./contextBuilder.js";
import { buildSystemMessage } from "./prompt.js";
import {
  getMemories,
  clearMemories,
  memoryTools,
  executeMemoryTool,
} from "./memory.js";
import { getChatConfig } from "./chatConfig.js";
import {
  registerConfigHandlers,
  handleWizardInput,
  isInWizard,
} from "./configCommand.js";

const bot = new Bot(BOT_TOKEN);

const OUR_COMMANDS = new Set(["image", "reset", "forget", "config"]);

/** Download an image from a URL and return it as a base64 data URL. */
async function toDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // Derive MIME from file extension – Telegram's content-type header can be
  // unreliable (e.g. application/octet-stream) or include parameters that
  // break the data-URL format (e.g. "image/jpeg; charset=utf-8").
  const MIME_MAP: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  };
  const ext = url.split(/[?#]/)[0].split(".").pop()?.toLowerCase() || "";
  const headerMime = (res.headers.get("content-type") || "")
    .split(";")[0]
    .trim();
  const mime =
    MIME_MAP[ext] ||
    (headerMime.startsWith("image/") ? headerMime : null) ||
    "image/jpeg";

  return `data:${mime};base64,${buf.toString("base64")}`;
}

// Global error handler to prevent crashes
bot.catch((err) => {
  const msg =
    (err as any)?.error?.message || (err as Error).message || "Unknown error";
  log.err(`Bot error: ${msg}`);
});

// Advertise bot commands
void bot.api.setMyCommands([
  { command: "image", description: "Generate an image from a text prompt" },
  { command: "reset", description: "Reset conversation context" },
  { command: "forget", description: "Clear all saved memories for this chat" },
  { command: "config", description: "Configure API credentials for this chat" },
]);

// Composite key: "chatId" or "chatId:threadId" for per-thread state
function threadKey(chatId: number, threadId?: number): string {
  return threadId != null ? `${chatId}:${threadId}` : String(chatId);
}

// Simple rolling memory per thread (stores Chat Completion message objects)
const memory = new Map<string, Array<any>>();

function storeMessage(key: string, msg: any) {
  if (!memory.has(key)) memory.set(key, []);
  const list = memory.get(key)!;
  list.push(msg);
  if (list.length > 15) list.shift();
}

/**
 * If the model doesn't support images, strip image_url parts from context
 * so that old image messages in history don't break subsequent requests.
 */
function sanitizeContext(messages: any[]): any[] {
  if (modelSupportsImages() !== false) return messages;
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    const textParts = msg.content.filter((p: any) => p.type !== "image_url");
    if (textParts.length === 0) return { ...msg, content: "[image]" };
    if (textParts.length === 1 && textParts[0].text)
      return { ...msg, content: textParts[0].text };
    return { ...msg, content: textParts };
  });
}

// Rate limiting (very light): 1 request per 2s per thread
const lastCall = new Map<string, number>();
function canRespond(key: string) {
  const now = Date.now();
  const prev = lastCall.get(key) ?? 0;
  if (now - prev < 2000) return false;
  lastCall.set(key, now);
  return true;
}

/** Build a sender tag like [First Last (@username)] from ctx.from */
function senderTag(ctx: Context): string {
  const from = ctx.from;
  if (!from) return "";
  const parts: string[] = [];
  if (from.first_name) parts.push(from.first_name);
  if (from.last_name) parts.push(from.last_name);
  const name = parts.join(" ") || "Unknown";
  const handle = from.username ? ` (@${from.username})` : "";
  return `[${name}${handle}] `;
}

// --- Access control helpers ---

function getCredentials(chatId: number): ApiCredentials | undefined {
  if (ALLOWED_IDS.has(chatId)) return undefined; // use global
  const cfg = getChatConfig(chatId);
  if (!cfg.apiKey) return undefined;
  return {
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl ?? BASE_URL,
  };
}

function hasAccess(chatId: number): boolean {
  if (ALLOWED_IDS.has(chatId)) return true;
  return !!getChatConfig(chatId).apiKey;
}

// --- Handler registration order matters ---

// 1. Config handlers (always accessible)
registerConfigHandlers(bot);

// 2. Access gate middleware
async function accessGate(ctx: Context, next: NextFunction) {
  const chatId = ctx.chat?.id;
  if (!chatId) return next();

  // Always allow /config and wizard interactions
  if (ctx.callbackQuery?.data?.startsWith("cfg:")) return next();
  if (isInWizard(chatId)) return next();

  const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  const botUsername = ctx.me?.username ?? "";
  const text = ctx.message?.text ?? ctx.message?.caption ?? "";

  // Check if this is a command directed at our bot
  const cmdMatch = text.match(/^\/(\w+)(?:@(\S+))?/);
  const isOurCommand = cmdMatch
    ? OUR_COMMANDS.has(cmdMatch[1]) && (!cmdMatch[2] || cmdMatch[2] === botUsername)
    : false;

  // In groups, ignore commands addressed to other bots entirely
  if (isGroup && cmdMatch && !isOurCommand) return;

  // /config always passes through
  if (isOurCommand && cmdMatch![1] === "config") return next();

  if (!hasAccess(chatId)) {
    const isMention = botUsername ? text.includes(`@${botUsername}`) : false;

    // In groups, only respond when directly @mentioned or our command is used
    const isDirected = !isGroup || isMention || isOurCommand;

    if (isDirected) {
      await ctx.reply(
        "You need to provide an API key to use this bot. Use /config to set one up.",
      );
    }
    return;
  }

  return next();
}

bot.use(accessGate);

// 3. Commands and message handlers

/**
 * Chat helper: builds system message with memories, runs the tool-calling loop,
 * and returns the final text response.  Supports streaming via optional onChunk
 * callback that receives the accumulated text snapshot on each content delta.
 */
async function chat(
  chatId: number,
  messages: any[],
  creds?: ApiCredentials,
  onChunk?: (snapshot: string) => void,
): Promise<string> {
  const memories = getMemories(chatId);
  const systemMsg = buildSystemMessage(memories);
  const msgs = [systemMsg, ...messages];

  let iterations = 0;
  while (iterations <= 5) {
    const stream = askSkyeStream(msgs, memoryTools, creds);

    // Only wire up streaming for the content phase (not tool-call iterations)
    if (onChunk) {
      stream.on("content", (_delta, snapshot) => onChunk(snapshot));
    }

    const completion = await stream.finalChatCompletion();
    const choice = completion.choices[0];

    if (!choice?.message?.tool_calls?.length) {
      return choice?.message?.content || "";
    }

    // Tool calls — process and loop
    msgs.push(choice.message);
    for (const tc of choice.message.tool_calls) {
      if (tc.type !== "function") continue;
      const result = await executeMemoryTool(chatId, tc);
      msgs.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
    iterations++;
  }
  return "";
}

// reset context (per-thread)
bot.command("reset", async (ctx) => {
  const tk = threadKey(ctx.chat.id, ctx.message?.message_thread_id);
  memory.delete(tk);
  await ctx.reply(
    "Context reset. Memories are still saved — use /forget to clear them.",
  );
});

// image generation (text-only prompt)
bot.command("image", async (ctx) => {
  const prompt = ctx.match?.trim();
  if (!prompt) {
    await ctx.reply(
      "Provide a description after /image, e.g. /image a cat on the moon",
    );
    return;
  }

  const tk = threadKey(ctx.chat.id, ctx.message?.message_thread_id);
  if (!canRespond(tk)) return;

  const creds = getCredentials(ctx.chat.id);

  void (async () => {
    log.info(`Image generation from ${ctx.chat.id}: ${prompt}`);

    // Keep the "uploading photo" indicator visible while generating
    const actionInterval = setInterval(() => {
      ctx.api.sendChatAction(ctx.chat.id, "upload_photo").catch(() => {});
    }, 4000);

    try {
      await ctx.api.sendChatAction(ctx.chat.id, "upload_photo");
      const buffer = await generateImage(prompt, undefined, creds);

      if (!buffer) {
        await ctx.reply("No image was generated. Try a different prompt.", {
          reply_to_message_id: ctx.message!.message_id,
        });
        return;
      }

      await ctx.replyWithPhoto(new InputFile(buffer, "image.png"), {
        reply_to_message_id: ctx.message!.message_id,
      });
    } catch (e: any) {
      log.err(`Image generation failed: ${e?.message || e}`);
      await ctx
        .reply("Failed to generate the image. Please try again.", {
          reply_to_message_id: ctx.message!.message_id,
        })
        .catch(() => {});
    } finally {
      clearInterval(actionInterval);
    }
  })();
});

// Clear all saved memories for this chat
bot.command("forget", async (ctx) => {
  await clearMemories(ctx.chat.id);
  await ctx.reply("All memories cleared.");
});

bot.on("message:text", async (ctx) => {
  // Wizard input interception — short-circuit before normal handling
  if (await handleWizardInput(ctx)) return;

  const isPM = ctx.chat.type === "private";
  const mention = ctx.message.text.includes(`@${ctx.me.username}`);

  if (!isPM && !mention) return; // groups: only when tagged

  const tk = threadKey(ctx.chat.id, ctx.message?.message_thread_id);
  if (!canRespond(tk)) return;

  void (async () => {
    log.info(`Incoming from ${ctx.chat.id}`);

    const creds = getCredentials(ctx.chat.id);
    const tag = senderTag(ctx);
    const userMsg = {
      role: "user" as const,
      content: tag + (ctx.message.text || ""),
    };
    const history = memory.get(tk) || [];
    const context = sanitizeContext(buildContext([...history, userMsg]));

    // Throttled streaming draft sender
    let lastDraft = 0;
    const onChunk = (snapshot: string) => {
      const now = Date.now();
      if (now - lastDraft < 300) return;
      lastDraft = now;
      (ctx as any).replyWithDraft?.(snapshot)?.catch(() => {});
    };

    try {
      const text = cleanMd(await chat(ctx.chat.id, context, creds, onChunk));

      if (!text) {
        await ctx.reply("I couldn't generate a response. Please try again.", {
          reply_to_message_id: ctx.message.message_id,
        });
        return;
      }

      storeMessage(tk, userMsg);
      storeMessage(tk, { role: "assistant", content: text });

      await ctx.reply(text, { reply_to_message_id: ctx.message.message_id });
    } catch (e: any) {
      log.err(`Text handler failed: ${e?.message || e}`);
      await ctx
        .reply("Something went wrong, please try again.", {
          reply_to_message_id: ctx.message.message_id,
        })
        .catch(() => {});
    }
  })();
});

// photo input: /image editing or vision analysis
const IMAGE_CMD_RE = /^\/image(?:@\S+)?\s*([\s\S]*)$/;

bot.on("message:photo", async (ctx) => {
  const isPM = ctx.chat.type === "private";
  const captionRaw = ctx.message.caption?.trim() || "";
  const imageMatch = captionRaw.match(IMAGE_CMD_RE);

  const tk = threadKey(ctx.chat.id, ctx.message?.message_thread_id);

  // --- Path 1: /image command with photo → image editing ---
  if (imageMatch) {
    const prompt = imageMatch[1].trim();
    if (!prompt) {
      await ctx.reply(
        "Provide a description after /image, e.g. /image make it cartoon",
        { reply_to_message_id: ctx.message.message_id },
      );
      return;
    }

    if (!canRespond(tk)) return;

    const creds = getCredentials(ctx.chat.id);

    void (async () => {
      log.info(`Image editing from ${ctx.chat.id}: ${prompt}`);

      const actionInterval = setInterval(() => {
        ctx.api.sendChatAction(ctx.chat.id, "upload_photo").catch(() => {});
      }, 4000);

      try {
        await ctx.api.sendChatAction(ctx.chat.id, "upload_photo");
        const file = await ctx.api.getFile(ctx.message.photo.pop()!.file_id);
        const photoUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        const dataUrl = await toDataUrl(photoUrl);
        const buffer = await generateImage(prompt, dataUrl, creds);

        if (!buffer) {
          await ctx.reply("No image was generated. Try a different prompt.", {
            reply_to_message_id: ctx.message.message_id,
          });
          return;
        }

        await ctx.replyWithPhoto(new InputFile(buffer, "image.png"), {
          reply_to_message_id: ctx.message.message_id,
        });
      } catch (e: any) {
        log.err(`Image editing failed: ${e?.message || e}`);
        await ctx
          .reply("Failed to edit the image. Please try again.", {
            reply_to_message_id: ctx.message.message_id,
          })
          .catch(() => {});
      } finally {
        clearInterval(actionInterval);
      }
    })();
    return;
  }

  // --- Path 2: vision analysis ---
  const hasMention = captionRaw.includes(`@${ctx.me.username}`);
  if (!isPM && (!captionRaw || !hasMention)) return;

  if (modelSupportsImages() === false) {
    await ctx.reply(
      "The current model does not support image input. Send text or switch to a vision-capable model.",
      { reply_to_message_id: ctx.message.message_id },
    );
    return;
  }

  if (!canRespond(tk)) return;

  const creds = getCredentials(ctx.chat.id);

  void (async () => {
    log.info(`Photo from ${ctx.chat.id}`);

    // Throttled streaming draft sender
    let lastDraft = 0;
    const onChunk = (snapshot: string) => {
      const now = Date.now();
      if (now - lastDraft < 300) return;
      lastDraft = now;
      (ctx as any).replyWithDraft?.(snapshot)?.catch(() => {});
    };

    try {
      const file = await ctx.api.getFile(ctx.message.photo.pop()!.file_id);
      const telegramUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const dataUrl = await toDataUrl(telegramUrl);

      const tag = senderTag(ctx);
      const parts: any[] = [];
      if (captionRaw) parts.push({ type: "text", text: tag + captionRaw });
      else if (tag) parts.push({ type: "text", text: tag.trim() });
      parts.push({ type: "image_url", image_url: { url: dataUrl } });

      const userMsg = { role: "user" as const, content: parts };
      const history = memory.get(tk) || [];
      const context = buildContext([...history, userMsg]);

      const text = cleanMd(await chat(ctx.chat.id, context, creds, onChunk));

      if (!text) {
        await ctx.reply(
          "I couldn't generate a response for this image. Please try again.",
          { reply_to_message_id: ctx.message.message_id },
        );
        return;
      }

      storeMessage(tk, userMsg);
      storeMessage(tk, { role: "assistant", content: text });

      await ctx.reply(text, { reply_to_message_id: ctx.message.message_id });
    } catch (e: any) {
      log.err(`Image handler failed: ${e?.message || e}`);
      await ctx
        .reply(
          "Failed to process the image. Please try again or send text instead.",
          { reply_to_message_id: ctx.message.message_id },
        )
        .catch(() => {});
    }
  })();
});

// Fetch model capabilities, then start
checkModelCapabilities().finally(() => {
  bot.start({ drop_pending_updates: true });
  log.info("Skye is alive");
});

import { Bot, InputFile, Context } from "grammy";
import { BOT_TOKEN } from "./config.js";
import { cleanMd } from "./utils/markdown.js";
import {
  askSkye,
  checkModelCapabilities,
  generateImage,
  modelSupportsImages,
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

const bot = new Bot(BOT_TOKEN);

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
]);

// Simple rolling memory per chat (stores Chat Completion message objects)
const memory = new Map<number, Array<any>>();

function storeMessage(chatId: number, msg: any) {
  if (!memory.has(chatId)) memory.set(chatId, []);
  const list = memory.get(chatId)!;
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

// Rate limiting (very light): 1 request per 2s per chat
const lastCall = new Map<number, number>();
function canRespond(chatId: number) {
  const now = Date.now();
  const prev = lastCall.get(chatId) ?? 0;
  if (now - prev < 2000) return false;
  lastCall.set(chatId, now);
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

/**
 * Chat helper: builds system message with memories, runs the tool-calling loop,
 * and returns the final text response.
 */
async function chat(chatId: number, messages: any[]): Promise<string> {
  const memories = getMemories(chatId);
  const systemMsg = buildSystemMessage(memories);
  const msgs = [systemMsg, ...messages];

  let response = await askSkye(msgs, memoryTools);
  let choice = response.choices[0];

  // Tool-calling loop (max 5 iterations to prevent runaway)
  let iterations = 0;
  while (choice?.message?.tool_calls?.length && iterations < 5) {
    iterations++;
    // Append the assistant message with tool calls
    msgs.push(choice.message);

    // Execute each tool call and append results
    for (const tc of choice.message.tool_calls) {
      if (tc.type !== "function") continue;
      const result = executeMemoryTool(chatId, tc);
      msgs.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });
    }

    response = await askSkye(msgs, memoryTools);
    choice = response.choices[0];
  }

  return choice?.message?.content || "";
}

// reset context
bot.command("reset", async (ctx) => {
  memory.delete(ctx.chat.id);
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

  if (!canRespond(ctx.chat.id)) return;

  log.info(`Image generation from ${ctx.chat.id}: ${prompt}`);

  // Keep the "uploading photo" indicator visible while generating
  const actionInterval = setInterval(() => {
    ctx.api.sendChatAction(ctx.chat.id, "upload_photo").catch(() => {});
  }, 4000);

  try {
    await ctx.api.sendChatAction(ctx.chat.id, "upload_photo");
    const buffer = await generateImage(prompt);

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
});

// Clear all saved memories for this chat
bot.command("forget", async (ctx) => {
  clearMemories(ctx.chat.id);
  await ctx.reply("All memories cleared.");
});

bot.on("message:text", async (ctx) => {
  const isPM = ctx.chat.type === "private";
  const mention = ctx.message.text.includes(`@${ctx.me.username}`);

  if (!isPM && !mention) return; // groups: only when tagged
  if (!canRespond(ctx.chat.id)) return;

  log.info(`Incoming from ${ctx.chat.id}`);

  const tag = senderTag(ctx);
  const userMsg = {
    role: "user" as const,
    content: tag + (ctx.message.text || ""),
  };
  const history = memory.get(ctx.chat.id) || [];
  const context = sanitizeContext(buildContext([...history, userMsg]));

  try {
    const text = cleanMd(await chat(ctx.chat.id, context));

    storeMessage(ctx.chat.id, userMsg);
    storeMessage(ctx.chat.id, { role: "assistant", content: text });

    await ctx.reply(text, { reply_to_message_id: ctx.message.message_id });
  } catch (e: any) {
    log.err(`Text handler failed: ${e?.message || e}`);
    await ctx
      .reply("Something went wrong, please try again.", {
        reply_to_message_id: ctx.message.message_id,
      })
      .catch(() => {});
  }
});

// photo input: /image editing or vision analysis
const IMAGE_CMD_RE = /^\/image(?:@\S+)?\s*([\s\S]*)$/;

bot.on("message:photo", async (ctx) => {
  const isPM = ctx.chat.type === "private";
  const captionRaw = ctx.message.caption?.trim() || "";
  const imageMatch = captionRaw.match(IMAGE_CMD_RE);

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

    if (!canRespond(ctx.chat.id)) return;

    log.info(`Image editing from ${ctx.chat.id}: ${prompt}`);

    const actionInterval = setInterval(() => {
      ctx.api.sendChatAction(ctx.chat.id, "upload_photo").catch(() => {});
    }, 4000);

    try {
      await ctx.api.sendChatAction(ctx.chat.id, "upload_photo");
      const file = await ctx.api.getFile(ctx.message.photo.pop()!.file_id);
      const photoUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const buffer = await generateImage(prompt, photoUrl);

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

  if (!canRespond(ctx.chat.id)) return;

  log.info(`Photo from ${ctx.chat.id}`);

  try {
    const file = await ctx.api.getFile(ctx.message.photo.pop()!.file_id);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    const tag = senderTag(ctx);
    const parts: any[] = [];
    if (captionRaw) parts.push({ type: "text", text: tag + captionRaw });
    else if (tag) parts.push({ type: "text", text: tag.trim() });
    parts.push({ type: "image_url", image_url: { url } });

    const userMsg = { role: "user" as const, content: parts };
    const history = memory.get(ctx.chat.id) || [];
    const context = buildContext([...history, userMsg]);

    const text = cleanMd(await chat(ctx.chat.id, context));

    storeMessage(ctx.chat.id, userMsg);
    storeMessage(ctx.chat.id, { role: "assistant", content: text });

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
});

// Fetch model capabilities, then start
checkModelCapabilities().finally(() => {
  bot.start({ drop_pending_updates: true });
  log.info("Skye is alive");
});

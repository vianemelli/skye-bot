import { Bot, InputFile } from "grammy";
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
  { command: "image", description: "Generate an image from a text prompt" },
  { command: "reset", description: "Reset conversation context" },
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

// reset context
bot.command("reset", async (ctx) => {
  memory.delete(ctx.chat.id);
  await ctx.reply("Context reset.");
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

bot.on("message:text", async (ctx) => {
  const isPM = ctx.chat.type === "private";
  const mention = ctx.message.text.includes(`@${ctx.me.username}`);

  if (!isPM && !mention) return; // groups: only when tagged
  if (!canRespond(ctx.chat.id)) return;

  log.info(`Incoming from ${ctx.chat.id}`);

  const userMsg = { role: "user" as const, content: ctx.message.text || "" };
  const history = memory.get(ctx.chat.id) || [];
  const msgs = [SYSTEM, ...sanitizeContext(buildContext([...history, userMsg]))];

  try {
    const response = await askSkye(msgs);
    const text = cleanMd(response.choices[0]?.message?.content || "");

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

    const parts: any[] = [];
    if (captionRaw) parts.push({ type: "text", text: captionRaw });
    parts.push({ type: "image_url", image_url: { url } });

    const userMsg = { role: "user" as const, content: parts };
    const history = memory.get(ctx.chat.id) || [];
    const msgs = [SYSTEM, ...buildContext([...history, userMsg])];

    const response = await askSkye(msgs);
    const text = cleanMd(response.choices[0]?.message?.content || "");

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

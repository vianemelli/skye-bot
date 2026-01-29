import { Bot, Context, InlineKeyboard } from "grammy";
import {
  getChatConfig,
  setChatApiKey,
  setChatBaseUrl,
  resetChatApiKey,
  resetChatBaseUrl,
} from "./chatConfig.js";

type WizardState = "api_key" | "base_url";
const wizardState = new Map<number, WizardState>();

export function isInWizard(chatId: number): boolean {
  return wizardState.has(chatId);
}

function buildPanel(chatId: number): { text: string; keyboard: InlineKeyboard } {
  const cfg = getChatConfig(chatId);
  const hasKey = !!cfg.apiKey;
  const hasUrl = !!cfg.baseUrl;

  const lines = [
    "*API Configuration*",
    "",
    `API Key: ${hasKey ? "\u2705 set" : "\u274c not set"}`,
    `Base URL: ${hasUrl ? `\u2705 ${cfg.baseUrl}` : "default"}`,
  ];

  const keyboard = new InlineKeyboard()
    .text("Set API Key", "cfg:set_key")
    .text("Set Base URL", "cfg:set_url")
    .row()
    .text("Reset API Key", "cfg:reset_key")
    .text("Reset Base URL", "cfg:reset_url")
    .row()
    .text("Close", "cfg:close");

  return { text: lines.join("\n"), keyboard };
}

export function registerConfigHandlers(bot: Bot): void {
  bot.command("config", async (ctx) => {
    const { text, keyboard } = buildPanel(ctx.chat.id);
    await ctx.reply(text, {
      reply_markup: keyboard,
      parse_mode: "Markdown",
    });
  });

  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("cfg:")) return next();

    const chatId = ctx.callbackQuery.message?.chat.id;
    if (!chatId) {
      await ctx.answerCallbackQuery("Unable to determine chat.");
      return;
    }

    switch (data) {
      case "cfg:set_key": {
        wizardState.set(chatId, "api_key");
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
          "Send your API key as the next message.\n\n_You should delete your message afterwards for safety._",
          { parse_mode: "Markdown" },
        );
        break;
      }
      case "cfg:set_url": {
        wizardState.set(chatId, "base_url");
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(
          "Send the base URL as the next message (e.g. `https://openrouter.ai/api/v1`).",
          { parse_mode: "Markdown" },
        );
        break;
      }
      case "cfg:reset_key": {
        resetChatApiKey(chatId);
        await ctx.answerCallbackQuery("API key reset.");
        const { text, keyboard } = buildPanel(chatId);
        await ctx.editMessageText(text, {
          reply_markup: keyboard,
          parse_mode: "Markdown",
        });
        break;
      }
      case "cfg:reset_url": {
        resetChatBaseUrl(chatId);
        await ctx.answerCallbackQuery("Base URL reset.");
        const { text, keyboard } = buildPanel(chatId);
        await ctx.editMessageText(text, {
          reply_markup: keyboard,
          parse_mode: "Markdown",
        });
        break;
      }
      case "cfg:close": {
        await ctx.answerCallbackQuery();
        await ctx.deleteMessage();
        break;
      }
      default:
        await ctx.answerCallbackQuery("Unknown action.");
    }
  });
}

/**
 * Intercepts the next text message when the user is in wizard mode.
 * Returns true if the message was consumed (caller should short-circuit).
 */
export async function handleWizardInput(ctx: Context): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;

  const state = wizardState.get(chatId);
  if (!state) return false;

  const text = ctx.message?.text?.trim();
  if (!text) {
    wizardState.delete(chatId);
    return true;
  }

  wizardState.delete(chatId);

  if (state === "api_key") {
    setChatApiKey(chatId, text);
  } else {
    setChatBaseUrl(chatId, text);
  }

  const { text: panelText, keyboard } = buildPanel(chatId);
  await ctx.reply(panelText, {
    reply_markup: keyboard,
    parse_mode: "Markdown",
  });

  return true;
}

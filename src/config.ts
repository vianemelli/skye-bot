import "dotenv/config";

export const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
export const OPENAI_KEY = process.env.OPENAI_KEY ?? "";
export const MODEL = process.env.MODEL ?? "openai/gpt-oss-120b";
export const BASE_URL = process.env.BASE_URL ?? "https://openrouter.ai/api/v1";
export const MAX_COMPLETION_TOKENS = parseInt(process.env.MAX_COMPLETION_TOKENS ?? "500");

export const ALLOWED_IDS: Set<number> = new Set(
  (process.env.ALLOWED_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n))
);

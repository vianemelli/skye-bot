import OpenAI from "openai";
import {
  BASE_URL,
  MAX_COMPLETION_TOKENS,
  MODEL,
  OPENAI_KEY,
} from "./config.js";

export const client = new OpenAI({
  baseURL: BASE_URL,
  apiKey: OPENAI_KEY,
});

// Basic helper: send text + optional images
export async function askSkye(messages: any[]) {
  return client.chat.completions.create({
    model: MODEL,
    messages: messages,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
  });
}

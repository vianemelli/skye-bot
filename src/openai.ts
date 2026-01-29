import OpenAI from "openai";
import {
  BASE_URL,
  MAX_COMPLETION_TOKENS,
  MODEL,
  OPENAI_KEY,
} from "./config.js";
import { log } from "./utils/log.js";

export interface ApiCredentials {
  apiKey: string;
  baseUrl: string;
}

const globalClient = new OpenAI({
  baseURL: BASE_URL,
  apiKey: OPENAI_KEY,
});

function getClient(creds?: ApiCredentials): OpenAI {
  if (!creds) return globalClient;
  return new OpenAI({ baseURL: creds.baseUrl, apiKey: creds.apiKey });
}

function resolveCredentials(creds?: ApiCredentials): { apiKey: string; baseUrl: string } {
  return {
    apiKey: creds?.apiKey ?? OPENAI_KEY,
    baseUrl: creds?.baseUrl ?? BASE_URL,
  };
}

// Basic helper: send text + optional images, with optional tool definitions
export async function askSkye(messages: any[], tools?: any[], creds?: ApiCredentials) {
  return getClient(creds).chat.completions.create({
    model: MODEL,
    messages,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    ...(tools?.length ? { tools } : {}),
  });
}

// --- Model capability detection (via OpenRouter /models endpoint) ---

let _supportsImages: boolean | null = null;

export async function checkModelCapabilities(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/models`);
    if (!res.ok) {
      log.warn(`Models endpoint returned ${res.status}, skipping capability check`);
      return;
    }
    const data = await res.json();
    const found = (data.data as any[])?.find((m: any) => m.id === MODEL);
    if (found) {
      const modality: string = found.architecture?.modality || "";
      _supportsImages = modality.toLowerCase().includes("image");
      log.info(
        `Model "${MODEL}" image support: ${_supportsImages} (modality: "${modality}")`,
      );
    } else {
      log.warn(`Model "${MODEL}" not found in models list`);
    }
  } catch (e: any) {
    log.warn(`Could not fetch model capabilities: ${e?.message || e}`);
  }
}

/** Returns true/false if known, null if capability check hasn't completed or failed */
export function modelSupportsImages(): boolean | null {
  return _supportsImages;
}

// --- Image generation (via OpenRouter chat completions with modalities) ---

const IMAGE_MODEL = "google/gemini-3-pro-image-preview";

export async function generateImage(prompt: string, imageUrl?: string, creds?: ApiCredentials): Promise<Buffer | null> {
  const { apiKey, baseUrl } = resolveCredentials(creds);

  const content: any = imageUrl
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageUrl } },
      ]
    : prompt;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Image generation failed (${res.status}): ${body}`);
  }

  const data: any = await res.json();
  const images = data.choices?.[0]?.message?.images;
  if (!images?.length) return null;

  const dataUrl: string = images[0].image_url.url;
  const base64 = dataUrl.split(",")[1];
  if (!base64) return null;

  return Buffer.from(base64, "base64");
}

import OpenAI from 'openai';
import { OPENAI_KEY } from './config.js';

export const client = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: OPENAI_KEY });

// Basic helper: send text + optional images
export async function askSkye(messages: any[]) {
  return client.chat.completions.create({
    model: 'openai/gpt-5.1',
    messages: messages,
    max_completion_tokens: 1000
  });
}
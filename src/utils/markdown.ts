// Telegram supports a tiny subset of Markdown. Strip everything else.
export function cleanMd(text: string) {
  // Remove common markdown formatting markers that could confuse Telegram
  let cleaned = text.replace(/[*_~`]/g, "");
  // Ensure no literal backslashes remain before punctuation (from prior escaping)
  cleaned = cleaned.replace(/\\([.!(){}\[\]])/g, "$1");
  return cleaned;
}

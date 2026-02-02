// Return the recent conversation context as-is (already in chat message format)
export function buildContext(messages: any[]) {
  // keep last 20 messages to bound context
  const start = Math.max(0, messages.length - 20);
  return messages.slice(start);
}

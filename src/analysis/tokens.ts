/** Rough token estimator: ~4 chars/token for English-ish text, floor at 1. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  // CJK chars are ~1 token each; heuristic blend.
  const cjk = text.match(/[\u3400-\u9FBF\u3040-\u30FF\uAC00-\uD7AF]/g)?.length ?? 0;
  const other = text.length - cjk;
  return Math.max(1, Math.ceil(other / 4) + cjk);
}

/** Estimate total prompt tokens for an OpenAI-style message array. */
export function estimateTokens(messages: Array<{ role: string; content: unknown }>): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // per-message overhead (role etc.)
    total += estimateContentTokens(m.content);
  }
  total += 2; // priming
  return total;
}

export function estimateContentTokens(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === "string") return estimateTextTokens(content);
  if (Array.isArray(content)) {
    let t = 0;
    for (const part of content) {
      if (typeof part === "string") t += estimateTextTokens(part);
      else if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") t += estimateTextTokens(p.text);
        if (p.type === "image_url" || p.type === "image") t += 800; // vision tokens heuristic
      }
    }
    return t;
  }
  if (typeof content === "object") {
    return estimateTextTokens(JSON.stringify(content));
  }
  return 0;
}

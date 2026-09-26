import type { ProviderModelInfo } from "../core/types.js";
import { OpenAiCompatAdapter } from "./openai-compat.js";

/**
 * Groq adapter — OpenAI-compatible API at https://api.groq.com/openai/v1.
 *
 * Free tier (verified against Groq's current docs, 2026-09): no credit card,
 * per-model rate limits around 30 RPM / 6k TPM / 1k RPD on standard models —
 * genuinely free capacity, but never unlimited. The upstream enforces the
 * exact per-model limit; our state store reacts to 429 with a cooldown.
 *
 * Requires GROQ_API_KEY. Without it the adapter is not registered, so the
 * router never claims capacity it cannot reach.
 */
export class GroqAdapter extends OpenAiCompatAdapter {
  readonly name = "groq";

  /** Live-catalog rows use bare ids ("llama-3.3-70b-versatile"); we keep them namespaced. */
  private static PREFIX = "groq:";

  toModelInfo(row: Record<string, unknown>): ProviderModelInfo | null {
    const id = typeof row.id === "string" ? row.id : null;
    if (!id) return null;
    const ctx = typeof row.context_window === "number" ? row.context_window : 8_000;
    const tools = row.supports_tool_use === true || row.tools === true;
    return {
      id: `${GroqAdapter.PREFIX}${id}`,
      context: ctx,
      maxOutput: typeof row.max_completion_tokens === "number" ? row.max_completion_tokens : Math.min(ctx, 32_768),
      tools,
      vision: false,
      audio: false,
      inputCostCentsPerMTok: null, // free-tier unmetered; paid rates not assumed
      outputCostCentsPerMTok: null,
      tier: classifyGroqTier(id, ctx),
    };
  }

  ownsModel(id: string): boolean {
    return id.startsWith(GroqAdapter.PREFIX);
  }

  protected override wireModel(id: string): string {
    return id.startsWith(GroqAdapter.PREFIX) ? id.slice(GroqAdapter.PREFIX.length) : id;
  }
}

function classifyGroqTier(id: string, ctx: number): ProviderModelInfo["tier"] {
  const m = id.toLowerCase();
  if (/^gpt-oss-120b/.test(m)) return "strong";
  if (/^gpt-oss-20b/.test(m)) return "mid";
  if (/^llama-3\.3-70b|^llama-4-maverick|^qwen|^deepseek-r1/.test(m)) return "strong";
  if (/^llama-4-scout|^llama-3\.1-8b|^qwen.*7b|mini|flash/.test(m)) return "mid";
  if (/8b|nano|lite|small|instant/.test(m)) return "light";
  return ctx >= 100_000 ? "mid" : "light";
}

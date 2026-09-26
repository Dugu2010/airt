import type { ProviderModelInfo } from "../core/types.js";
import { OpenAiCompatAdapter } from "./openai-compat.js";

/**
 * OpenRouter adapter — OpenAI-compatible API at https://openrouter.ai/api/v1.
 *
 * Free capacity (verified against OpenRouter's current docs, 2026-09):
 * models with a `:free` suffix are free with plan-dependent rate limits
 * (20 RPM; 50 RPD on a fresh account, 1000 RPD after a one-time $10 credit
 * purchase). Never unlimited — the upstream enforces the cap and our state
 * store reacts to 429 with a cooldown. Non-`:free` ids are catalogued too
 * (they are metered paid models; FREE mode's cost scoring naturally deprioritizes
 * them, and they widen capability coverage for hard tasks).
 *
 * Requires OPENROUTER_API_KEY. Without it the adapter is not registered.
 */
export class OpenRouterAdapter extends OpenAiCompatAdapter {
  readonly name = "openrouter";

  private static PREFIX = "openrouter:";

  toModelInfo(row: Record<string, unknown>): ProviderModelInfo | null {
    const id = typeof row.id === "string" ? row.id : null;
    if (!id) return null;
    const ctx = typeof row.context_length === "number" ? row.context_length : 8_000;
    const pricing = (row.pricing ?? {}) as Record<string, unknown>;
    const promptUsdPerMTok = Number(pricing.prompt ?? "0") * 1_000_000;
    const completionUsdPerMTok = Number(pricing.completion ?? "0") * 1_000_000;
    const isFree = id.endsWith(":free") || (promptUsdPerMTok === 0 && completionUsdPerMTok === 0);
    const architecture = (row.architecture ?? {}) as { input_modalities?: string[] };
    return {
      id: `${OpenRouterAdapter.PREFIX}${id}`,
      context: ctx,
      maxOutput: typeof row.max_completion_tokens === "number" ? row.max_completion_tokens : Math.min(ctx, 32_768),
      tools: row.supported_parameters !== undefined
        ? (row.supported_parameters as string[]).includes("tools")
        : true,
      vision: Array.isArray(architecture.input_modalities)
        ? architecture.input_modalities.includes("image")
        : false,
      audio: false,
      inputCostCentsPerMTok: isFree ? 0 : Math.ceil(promptUsdPerMTok * 100),
      outputCostCentsPerMTok: isFree ? 0 : Math.ceil(completionUsdPerMTok * 100),
      tier: classifyOpenRouterTier(id, isFree, ctx),
    };
  }

  ownsModel(id: string): boolean {
    return id.startsWith(OpenRouterAdapter.PREFIX);
  }

  protected override wireModel(id: string): string {
    return id.startsWith(OpenRouterAdapter.PREFIX) ? id.slice(OpenRouterAdapter.PREFIX.length) : id;
  }
}

function classifyOpenRouterTier(id: string, isFree: boolean, ctx: number): ProviderModelInfo["tier"] {
  const m = id.toLowerCase();
  // strong families keep their strength even in free variants
  if (/deepseek-r1|deepseek-v3|deepseek-chat|qwen3-235b|llama-3\.3-70b|gpt-oss-120b|kimi-k2|glm-4\.6|nemotron-ultra/.test(m)) return "strong";
  if (/opus|gpt-5(?!-)|gpt-5\.|o3|o4|grok-4|gemini-2\.5-pro|claude-sonnet-4/.test(m)) return "top";
  if (/deepseek|qwen|llama|mistral|glm|gpt-oss/.test(m)) return "mid";
  if (isFree && ctx >= 32_000) return "mid";
  return ctx >= 100_000 ? "mid" : "light";
}

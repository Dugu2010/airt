import type { ProviderModelInfo } from "../core/types.js";
import { OpenAiCompatAdapter } from "./openai-compat.js";

/**
 * Mistral La Plateforme adapter — OpenAI-compatible endpoint at
 * https://api.mistral.ai/v1
 *
 * Free-tier status (researched 2026-09-26 from official docs + current
 * third-party guides; MEDIUM confidence — limits are plan-dependent and can
 * change): La Plateforme has a free "experimental" plan with ~1 req/s and a
 * large monthly token allowance (reported ~500k TPM / ~1B tokens/month),
 * phone verification + data-training opt-in required. Not unlimited.
 *
 * Requires MISTRAL_API_KEY. Implemented but unverified live in this workspace.
 */
export class MistralAdapter extends OpenAiCompatAdapter {
  readonly name = "mistral";

  private static PREFIX = "mistral:";

  toModelInfo(row: Record<string, unknown>): ProviderModelInfo | null {
    const id = typeof row.id === "string" ? row.id : null;
    if (!id) return null;
    const caps = (row.capabilities ?? {}) as Record<string, unknown>;
    const ctx = typeof row.max_context_length === "number" ? row.max_context_length : 32_768;
    return {
      id: `${MistralAdapter.PREFIX}${id}`,
      context: ctx,
      maxOutput: 8_192,
      tools: caps.function_calling === true,
      vision: caps.vision === true,
      audio: caps.audio === true,
      inputCostCentsPerMTok: null,
      outputCostCentsPerMTok: null,
      tier: classifyMistralTier(id),
    };
  }

  ownsModel(id: string): boolean {
    return id.startsWith(MistralAdapter.PREFIX);
  }

  protected override wireModel(id: string): string {
    return id.startsWith(MistralAdapter.PREFIX) ? id.slice(MistralAdapter.PREFIX.length) : id;
  }
}

function classifyMistralTier(id: string): ProviderModelInfo["tier"] {
  const m = id.toLowerCase();
  if (/large|medium|magistral/.test(m)) return "strong";
  if (/small|codestral/.test(m)) return "mid";
  return "light"; // ministral / 3b / 7b class
}

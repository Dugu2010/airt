import type { ProviderModelInfo } from "../core/types.js";

/**
 * Static seed registry for Puter models (verified live against
 * https://api.puter.com/puterai/chat/models/details on 2026-09-26).
 * The live refresh (`refreshFromCatalog`) overrides context/cost/modality
 * fields from the current catalog, so these entries mainly pin tiers and ids.
 *
 * Free-access note: all Puter models are reachable via the user-pays driver;
 * usage is metered against the account's free allowance. Cheap-cost models
 * conserve that allowance best — there is no "unlimited free" tier.
 */
export const PUTER_REGISTRY_SEED: ProviderModelInfo[] = [
  // ---- top tier (strongest general/reasoning/coding) ----
  { id: "openai:openai/gpt-5.6-sol", context: 1_050_000, maxOutput: 128_000, tools: true, vision: true, audio: false, inputCostCentsPerMTok: 400, outputCostCentsPerMTok: 2000, tier: "top" },
  { id: "openai:openai/gpt-5.6-terra", context: 1_050_000, maxOutput: 128_000, tools: true, vision: true, audio: false, inputCostCentsPerMTok: 200, outputCostCentsPerMTok: 1200, tier: "top" },
  { id: "openai:openai/gpt-6-sol", context: 1_050_000, maxOutput: 128_000, tools: true, vision: true, audio: false, inputCostCentsPerMTok: 200, outputCostCentsPerMTok: 1000, tier: "top" },
  { id: "anthropic:anthropic/claude-opus-5-5", context: 1_000_000, maxOutput: 128_000, tools: true, vision: true, audio: false, inputCostCentsPerMTok: 500, outputCostCentsPerMTok: 2500, tier: "top" },
  { id: "anthropic:anthropic/claude-sonnet-5", context: 1_000_000, maxOutput: 128_000, tools: true, vision: true, audio: false, inputCostCentsPerMTok: 150, outputCostCentsPerMTok: 750, tier: "top" },
  { id: "google:google/gemini-3.8-flash", context: 1_048_576, maxOutput: 65_536, tools: true, vision: true, audio: true, inputCostCentsPerMTok: 75, outputCostCentsPerMTok: 375, tier: "top" },
  { id: "openai:openai/gpt-5", context: 128_000, maxOutput: 128_000, tools: true, vision: true, audio: false, inputCostCentsPerMTok: 125, outputCostCentsPerMTok: 1000, tier: "top" },

  // ---- strong tier (very capable, cheaper) ----
  { id: "openai:openai/gpt-5.6-luna", context: 1_050_000, maxOutput: 128_000, tools: true, vision: true, audio: false, inputCostCentsPerMTok: 20, outputCostCentsPerMTok: 120, tier: "strong" },
  { id: "xai:x-ai/grok-4.3", context: 2_000_000, maxOutput: 128_000, tools: true, vision: true, audio: false, inputCostCentsPerMTok: 30, outputCostCentsPerMTok: 150, tier: "strong" },
  { id: "deepseek:deepseek/deepseek-v4-pro", context: 160_000, maxOutput: 96_000, tools: true, vision: false, audio: false, inputCostCentsPerMTok: 28, outputCostCentsPerMTok: 112, tier: "strong" },
  { id: "google:google/gemini-3.5-flash", context: 1_048_576, maxOutput: 65_536, tools: true, vision: true, audio: true, inputCostCentsPerMTok: 50, outputCostCentsPerMTok: 250, tier: "strong" },
  { id: "anthropic:anthropic/claude-haiku-4-5", context: 200_000, maxOutput: 64_000, tools: true, vision: true, audio: false, inputCostCentsPerMTok: 50, outputCostCentsPerMTok: 250, tier: "strong" },

  // ---- mid tier (great quality/price, fast) ----
  { id: "deepseek:deepseek/deepseek-v4-flash", context: 1_000_000, maxOutput: 384_000, tools: true, vision: false, audio: false, inputCostCentsPerMTok: 14, outputCostCentsPerMTok: 28, tier: "mid" },
  { id: "openai:openai/gpt-4o-mini", context: 128_000, maxOutput: 16_384, tools: true, vision: true, audio: false, inputCostCentsPerMTok: 15, outputCostCentsPerMTok: 60, tier: "mid" },
  { id: "openai:openai/gpt-4.1-mini", context: 1_047_576, maxOutput: 32_768, tools: true, vision: true, audio: false, inputCostCentsPerMTok: 20, outputCostCentsPerMTok: 80, tier: "mid" },
  { id: "infron:deepseek/deepseek-r1", context: 128_000, maxOutput: 64_000, tools: false, vision: false, audio: false, inputCostCentsPerMTok: 60, outputCostCentsPerMTok: 240, tier: "mid" },

  // ---- light tier (cheapest, for trivial tasks + decision-making) ----
  { id: "alibaba:qwen/qwen3.7-flash", context: 1_000_000, maxOutput: 65_536, tools: true, vision: false, audio: false, inputCostCentsPerMTok: 3, outputCostCentsPerMTok: 13, tier: "light" },
  { id: "alibaba:qwen/qwen-flash", context: 1_000_000, maxOutput: 65_536, tools: true, vision: false, audio: false, inputCostCentsPerMTok: 5, outputCostCentsPerMTok: 40, tier: "light" },
  { id: "google:google/gemini-3.5-flash-lite", context: 1_048_576, maxOutput: 65_536, tools: true, vision: true, audio: true, inputCostCentsPerMTok: 30, outputCostCentsPerMTok: 250, tier: "light" },
  { id: "openai:openai/gpt-5-nano", context: 128_000, maxOutput: 128_000, tools: true, vision: true, audio: false, inputCostCentsPerMTok: 5, outputCostCentsPerMTok: 40, tier: "light" },
  { id: "openai:openai/gpt-4.1-nano", context: 1_047_576, maxOutput: 32_768, tools: true, vision: true, audio: false, inputCostCentsPerMTok: 10, outputCostCentsPerMTok: 40, tier: "light" },
];

/** Tier rank: lower is more capable. */
export const TIER_RANK: Record<ProviderModelInfo["tier"], number> = {
  top: 0,
  strong: 1,
  mid: 2,
  light: 3,
};

export class ModelRegistry {
  private models = new Map<string, ProviderModelInfo>();

  constructor(seed: ProviderModelInfo[] = PUTER_REGISTRY_SEED) {
    for (const m of seed) this.models.set(m.id, { ...m });
  }

  /** Merge live catalog data (context, cost, modalities) into the registry. */
  refresh(entries: Array<Partial<ProviderModelInfo> & { id: string }>): void {
    for (const e of entries) {
      const existing = this.models.get(e.id);
      // Adapters that classify their own models (OpenAI-compatible providers)
      // pass `tier` explicitly; their classification wins. Puter adapters omit
      // it, preserving the seed tier for known entries.
      const tier: ProviderModelInfo["tier"] =
        e.tier ?? (existing ? existing.tier : inferTierFromCost(e.inputCostCentsPerMTok));
      if (existing) {
        this.models.set(e.id, { ...existing, ...e, tier });
      } else {
        this.models.set(e.id, {
          id: e.id,
          context: e.context ?? 128_000,
          maxOutput: e.maxOutput ?? 32_768,
          tools: e.tools ?? false,
          vision: e.vision ?? false,
          audio: e.audio ?? false,
          inputCostCentsPerMTok: e.inputCostCentsPerMTok ?? null,
          outputCostCentsPerMTok: e.outputCostCentsPerMTok ?? null,
          tier,
        });
      }
    }
  }

  get(id: string): ProviderModelInfo | null {
    return this.models.get(id) ?? null;
  }

  all(): ProviderModelInfo[] {
    return [...this.models.values()];
  }
}

/** Cost-based tier inference for unknown models whose adapter does not classify. */
function inferTierFromCost(inputCostCentsPerMTok: number | null | undefined): ProviderModelInfo["tier"] {
  if (inputCostCentsPerMTok == null) return "mid";
  if (inputCostCentsPerMTok <= 10) return "light";
  if (inputCostCentsPerMTok <= 50) return "mid";
  if (inputCostCentsPerMTok <= 200) return "strong";
  return "top";
}

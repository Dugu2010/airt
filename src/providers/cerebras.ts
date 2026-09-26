import type { ProviderModelInfo } from "../core/types.js";
import { OpenAiCompatAdapter, type OpenAiCompatConfig } from "./openai-compat.js";

/**
 * Cerebras Inference adapter — OpenAI-compatible endpoint at
 * https://api.cerebras.ai/v1
 *
 * Free-tier status (VERIFIED against official docs at
 * https://inference-docs.cerebras.ai/support/rate-limits on 2026-09-26):
 * the official FAQ states there is NO permanently free tier — new accounts
 * receive $5 in trial credits that expire after 30 days and require adding a
 * verified payment method. Free Trial tier limits (per model): 5 RPM /
 * 30K uncached TPM / 90K total TPM / 1M TPH / 1M TPD.
 *
 * Classification: temporary promotional credits + trial — NOT permanent free
 * capacity. This adapter is therefore "implemented but unverified" and must
 * never be advertised as a free provider. It is only registered when
 * CEREBRAS_API_KEY exists, and its models are excluded from FREE mode's
 * free-capacity preference (cost fields left null = unknown, not zero).
 */
export class CerebrasAdapter extends OpenAiCompatAdapter {
  readonly name = "cerebras";

  private static PREFIX = "cerebras:";

  toModelInfo(row: Record<string, unknown>): ProviderModelInfo | null {
    const id = typeof row.id === "string" ? row.id : null;
    if (!id) return null;
    const ctx = 128_000; // gpt-oss-120b / qwen3.8-27b class context
    return {
      id: `${CerebrasAdapter.PREFIX}${id}`,
      context: ctx,
      maxOutput: 8_192,
      tools: true,
      vision: false,
      audio: false,
      inputCostCentsPerMTok: null, // trial-tier: cost model unknown; NOT free
      outputCostCentsPerMTok: null,
      tier: /gpt-oss-120b/.test(id) ? "strong" : "mid",
    };
  }

  ownsModel(id: string): boolean {
    return id.startsWith(CerebrasAdapter.PREFIX);
  }

  protected override wireModel(id: string): string {
    return id.startsWith(CerebrasAdapter.PREFIX) ? id.slice(CerebrasAdapter.PREFIX.length) : id;
  }
}

export type { OpenAiCompatConfig };

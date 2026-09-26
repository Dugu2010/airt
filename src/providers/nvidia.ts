import type { ProviderModelInfo } from "../core/types.js";
import { OpenAiCompatAdapter } from "./openai-compat.js";

/**
 * NVIDIA NIM (build.nvidia.com hosted inference) adapter — OpenAI-compatible
 * endpoint at https://integrate.api.nvidia.com/v1
 *
 * Free-tier status (researched 2026-09-26; MEDIUM confidence): NVIDIA grants
 * API credits for hosted NIM endpoints (commonly 1000+ credits on signup);
 * it is credit-based trial capacity, NOT a documented permanent free tier and
 * NOT unlimited. Exact credit values are account-dependent and not published
 * as a stable number — so nothing here is assumed.
 *
 * Requires NVIDIA_API_KEY (or NIM_API_KEY). Implemented but unverified live
 * in this workspace.
 */
export class NvidiaAdapter extends OpenAiCompatAdapter {
  readonly name = "nvidia";

  private static PREFIX = "nvidia:";

  toModelInfo(row: Record<string, unknown>): ProviderModelInfo | null {
    const id = typeof row.id === "string" ? row.id : null;
    if (!id) return null;
    const ctx = typeof row.max_model_len === "number" ? row.max_model_len : 32_768;
    return {
      id: `${NvidiaAdapter.PREFIX}${id}`,
      context: ctx,
      maxOutput: 8_192,
      tools: /nemotron|llama-3|qwen|deepseek/.test(id.toLowerCase()),
      vision: /vl|maverick|scout/.test(id.toLowerCase()),
      audio: false,
      inputCostCentsPerMTok: null, // credit-based: no stable published per-token price
      outputCostCentsPerMTok: null,
      tier: classifyNvidiaTier(id),
      free: false, // credit-based allocation — not a documented free tier
    };
  }

  ownsModel(id: string): boolean {
    return id.startsWith(NvidiaAdapter.PREFIX);
  }

  protected override wireModel(id: string): string {
    return id.startsWith(NvidiaAdapter.PREFIX) ? id.slice(NvidiaAdapter.PREFIX.length) : id;
  }
}

function classifyNvidiaTier(id: string): ProviderModelInfo["tier"] {
  const m = id.toLowerCase();
  if (/405b|ultra|deepseek-r1/.test(m)) return "strong";
  if (/70b|super|qwen|235b/.test(m)) return "mid";
  return "light";
}

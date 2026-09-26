import type { ProviderModelInfo } from "../core/types.js";
import { OpenAiCompatAdapter, type OpenAiCompatConfig } from "./openai-compat.js";

/**
 * Google AI Studio (Gemini API) adapter — OpenAI-compatible endpoint at
 * https://generativelanguage.googleapis.com/v1beta/openai/
 *
 * Free tier (VERIFIED against official docs at
 * https://ai.google.dev/gemini-api/docs/rate-limits on 2026-09-26):
 * - permanently free tier exists ("Free" usage tier, qualification: active
 *   project or free trial; no billing required)
 * - limits are per project: RPM + TPM + RPD; RPD resets at midnight Pacific
 * - flash models historically ~10-20 RPD on the free tier (third-party
 *   trackers; exact per-model values are shown in AI Studio and can change)
 * - never unlimited; the upstream enforces 429 RESOURCE_EXHAUSTED
 *
 * Requires GOOGLE_API_KEY (or GEMINI_API_KEY). Unverified live in this
 * workspace (no credential available).
 */
export class GoogleAiStudioAdapter extends OpenAiCompatAdapter {
  readonly name = "google-ai-studio";

  private static PREFIX = "gai:";

  toModelInfo(row: Record<string, unknown>): ProviderModelInfo | null {
    const id = typeof row.id === "string" ? row.id : null;
    if (!id) return null;
    // Gemini context windows: pro ~1M-2M, flash ~1M, lite ~1M; min(name*1M, 2M)
    const ctx = id.includes("pro") ? 2_000_000 : id.includes("flash") ? 1_000_000 : 32_768;
    const supported = Array.isArray(row.supported_generation_methods)
      ? (row.supported_generation_methods as string[])
      : null;
    return {
      id: `${GoogleAiStudioAdapter.PREFIX}${id}`,
      context: ctx,
      maxOutput: 8_192,
      tools: supported ? supported.includes("generateContent") : true,
      vision: /gemini/.test(id), // gemini models are multimodal; embedding/tts are not chat
      audio: false,
      inputCostCentsPerMTok: null, // free-tier unmetered; paid rates not assumed
      outputCostCentsPerMTok: null,
      tier: classifyGoogleTier(id),
      free: true, // AI Studio free usage tier (per-project RPM/TPM/RPD)
    };
  }

  ownsModel(id: string): boolean {
    return id.startsWith(GoogleAiStudioAdapter.PREFIX);
  }

  protected override wireModel(id: string): string {
    return id.startsWith(GoogleAiStudioAdapter.PREFIX) ? id.slice(GoogleAiStudioAdapter.PREFIX.length) : id;
  }
}

function classifyGoogleTier(id: string): ProviderModelInfo["tier"] {
  const m = id.toLowerCase();
  if (/pro/.test(m)) return "top";
  if (/flash-lite/.test(m)) return "light";
  if (/flash/.test(m)) return "strong";
  if (/embedding|tts|image|audio|veo|imagen/.test(m)) return "light";
  return "mid";
}

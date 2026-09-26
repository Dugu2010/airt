import type { DecisionContext } from "./decision.js";
import type { ProviderAdapter } from "../core/types.js";

export interface AiSelectorConfig {
  decisionAdapter: ProviderAdapter;
  model: string;
  fallbackModels: string[];
  timeoutMs: number;
}

export interface AiSelectorInput {
  ctx: DecisionContext;
  candidates: Array<{ model: string; score: number; free?: boolean; quotaRemaining?: number | null }>;
  taskText: string;
}

const SYSTEM_PROMPT = `You are the model-selection brain of an AI inference router.
Given a request and candidate models, pick the BEST model for THIS request.
Task fit first (capability needed), then cost efficiency, then speed.
Trivial tasks should use cheap fast models; hard reasoning/coding deserves top-tier models.
Candidates are annotated with tier and, for free-tier models, remaining daily quota.
ALWAYS prefer a FREE-tier model with remaining quota that can handle the task;
choose a PAID model only when no free candidate is adequate.
Respond with ONLY minified JSON, no markdown: {"order":["<model-id>",...]}
Include 2-4 model ids from the candidate list, best first.`;

const BASE_MAX_TOKENS = 300;
const RETRY_MAX_TOKENS = 1500;

/**
 * Ask the decision model to re-rank candidates. Returns null on any failure
 * (caller falls back to deterministic routing).
 *
 * Robustness: some models (observed live with gpt-5-nano) emit empty content
 * with finish_reason "length" when their internal reasoning consumes the token
 * budget before any visible text. When content is empty/JSON-less AND the
 * finish reason indicates truncation, we retry the SAME model once with a
 * larger budget before moving to fallback models.
 */
export async function aiSelectModels(cfg: AiSelectorConfig, input: AiSelectorInput): Promise<string[] | null> {
  const { ctx, candidates, taskText } = input;
  if (candidates.length === 0) return null;

  const userPrompt = [
    `REQUEST: ${taskText.slice(0, 2000)}`,
    `TASK: type=${ctx.analysis.primary} difficulty=${ctx.analysis.difficulty} est_prompt_tokens=${ctx.analysis.estimatedPromptTokens} tools=${ctx.tools.length > 0}`,
    `MODE: ${ctx.mode}`,
    `CANDIDATES:`,
    ...candidates.slice(0, 8).map((c, i) => {
      const tag = c.free === true
        ? `FREE${c.quotaRemaining != null ? ` · ~${Math.round(c.quotaRemaining * 100)}% quota left` : " · quota unknown"}`
        : "PAID";
      return `${i + 1}. [${tag}] ${c.model} (score ${c.score.toFixed(2)})`;
    }),
  ].join("\n");

  for (const model of [cfg.model, ...cfg.fallbackModels]) {
    let maxTokens = BASE_MAX_TOKENS;
    // one truncation-retry per model
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
        const result = await cfg.decisionAdapter.chat(
          {
            model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ],
            stream: false,
            max_tokens: maxTokens,
            temperature: 0,
          },
          controller.signal
        );
        clearTimeout(timer);
        const content = result.message.content ?? "";
        const parsed = extractJson(content);
        if (parsed) {
          const order = Array.isArray(parsed.order)
            ? parsed.order.filter((x): x is string => typeof x === "string")
            : null;
          if (order && order.length > 0) return order;
        }
        const truncated = result.finishReason === "length" || result.finishReason === "max_tokens";
        if (attempt === 0 && truncated && content.trim().length === 0) {
          maxTokens = RETRY_MAX_TOKENS; // reasoning consumed the budget; retry larger
          continue;
        }
        break; // non-truncation failure → next fallback model
      } catch {
        break; // timeout/connection → next fallback model
      }
    }
  }
  return null;
}

/** Extract the first JSON object from a model reply (handles ```json fences). */
export function extractJson(text: string): { order?: unknown } | null {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as { order?: unknown };
  } catch {
    return null;
  }
}

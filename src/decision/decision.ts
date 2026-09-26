import type {
  ChatMessage,
  ProviderAdapter,
  RoutingMode,
  RoutingDecision,
  ScoredCandidate,
  TaskAnalysis,
  Tool,
} from "../core/types.js";
import { TIER_RANK } from "../registry/registry.js";
import type { ProviderStateStore } from "../state/state.js";

export interface DecisionContext {
  mode: RoutingMode;
  analysis: TaskAnalysis;
  messages: ChatMessage[];
  tools: Tool[];
  availableProviders: Array<{ adapter: ProviderAdapter; state: ProviderStateStore }>;
}

export interface DecisionEngineDeps {
  /** AI decision caller; returns an ordered list of preferred model ids or null. */
  aiSelect?: (ctx: DecisionContext) => Promise<string[] | null>;
  rulesOnly?: boolean;
  /** FREE-mode policy when no capable free/cheap candidate exists:
   * "reject" (default) refuses to spend money; "allow-paid" permits paid fallback. */
  freeFallbackPolicy?: "reject" | "allow-paid";
}

const MODE_WEIGHTS: Record<RoutingMode, { capability: number; cost: number; speed: number; health: number; fit: number }> = {
  auto: { capability: 0.35, cost: 0.2, speed: 0.15, health: 0.2, fit: 0.1 },
  fast: { capability: 0.15, cost: 0.1, speed: 0.45, health: 0.2, fit: 0.1 },
  quality: { capability: 0.55, cost: 0.05, speed: 0.1, health: 0.2, fit: 0.1 },
  reasoning: { capability: 0.45, cost: 0.1, speed: 0.1, health: 0.2, fit: 0.15 },
  free: { capability: 0.15, cost: 0.45, speed: 0.1, health: 0.2, fit: 0.1 },
  balanced: { capability: 0.3, cost: 0.25, speed: 0.15, health: 0.2, fit: 0.1 },
};

export interface ScoreOptions {
  /** Skip the circuit-breaker gate (used for in-flight failover). Quota still applies. */
  ignoreCircuit?: boolean;
}

/** Deterministic scoring — always runs, provides the candidate pool + baseline order. */
export function scoreCandidates(
  ctx: DecisionContext,
  options: ScoreOptions = {}
): { scored: ScoredCandidate[]; rejected: Array<{ model: string; reason: string }>; freeCheapExhausted?: boolean } {
  const w = MODE_WEIGHTS[ctx.mode];
  const scored: ScoredCandidate[] = [];
  const rejected: Array<{ model: string; reason: string }> = [];
  const tierByModel = new Map<string, string>();

  const needsTools = ctx.tools.length > 0;
  const needsVision = ctx.analysis.requiresVision;
  const needsContext = ctx.analysis.estimatedPromptTokens + (ctx.analysis.estimatedPromptTokens >> 2); // +25% headroom

  for (const { adapter, state } of ctx.availableProviders) {
    const capacity = state.availableCapacity(adapter.name);
    for (const model of adapter.listModelsSync()) {
      const cap = adapter.capabilities(model);
      if (!cap) continue;
      tierByModel.set(model, cap.tier);

      // hard filters
      if (needsTools && !cap.tools) {
        rejected.push({ model, reason: "no tool support" });
        continue;
      }
      if (needsVision && !cap.vision) {
        rejected.push({ model, reason: "no vision support" });
        continue;
      }
      if (cap.context < needsContext) {
        rejected.push({ model, reason: `context ${cap.context} < required ~${needsContext}` });
        continue;
      }
      if (!capacity.ok) {
        const circuitOnly = capacity.reason === "circuit_open";
        if (options.ignoreCircuit && circuitOnly) {
          // in-flight failover may still use this provider
        } else {
          rejected.push({ model, reason: `provider unavailable: ${capacity.reason}` });
          continue;
        }
      }

      // ---- soft scoring 0..1 each ----
      const capability = 1 - TIER_RANK[cap.tier] / 3; // top=1, light=0
      const health = state.health(adapter.name);
      const healthScore =
        (health.successRate ?? 0.8) * 0.5 + (health.open ? 0 : 0.3) + Math.max(0, 1 - (health.latencyEmaMs ?? 1500) / 10_000) * 0.2;

      const inCost = cap.inputCostCentsPerMTok ?? 100;
      const costScore = Math.max(0, 1 - inCost / 500);
      const speedScore =
        Math.max(0, 1 - (health.latencyEmaMs ?? 1500) / 6_000) * 0.6 + (cap.tier === "light" ? 0.4 : cap.tier === "mid" ? 0.25 : 0.05);
      const fit = fitScore(ctx.analysis, cap);

      const total = capability * w.capability + costScore * w.cost + speedScore * w.speed + healthScore * w.health + fit * w.fit;

      scored.push({
        provider: adapter.name,
        model,
        score: Number(total.toFixed(4)),
        reasons: [`tier=${cap.tier} capability=${capability.toFixed(2)}`, `cost=${inCost}c/MTok`, `mode=${ctx.mode}`],
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // FREE mode conserves money/allowance: when the task does not demand top-tier
  // capability, restrict the pool to cheaper tiers (light/mid). Every model in
  // `scored` already passed the hard filters (tools/vision/context/health), so
  // the restricted pool remains capability-compatible by construction. If no
  // cheaper model can serve the request, the full pool is kept — the caller
  // (decideRouting) applies the configured paid-fallback policy to that case.
  if (ctx.mode === "free" && ctx.analysis.difficulty <= 3 && scored.length >= 1) {
    const cheap = scored.filter((c) => {
      const t = tierByModel.get(c.model);
      return t === "light" || t === "mid";
    });
    if (cheap.length > 0) {
      const cheapSet = new Set(cheap.map((c) => c.model));
      const skipped = scored.filter((c) => !cheapSet.has(c.model)).map((c) => ({
        model: c.model,
        reason: "free mode: expensive tier skipped (cost minimization)",
      }));
      return { scored: cheap, rejected: [...rejected, ...skipped] };
    }
    // No light/mid candidate survived the hard filters: the only options are
    // expensive. Flag it so decideRouting can apply the configured fallback
    // policy (reject = never silently spend money).
    return { scored, rejected, freeCheapExhausted: true };
  }

  return { scored, rejected };
}

function fitScore(analysis: TaskAnalysis, cap: ProviderModelInfo_t): number {
  if (analysis.difficulty <= 2) return cap.tier === "light" ? 1 : cap.tier === "mid" ? 0.7 : 0.4;
  if (analysis.difficulty === 3) return cap.tier === "mid" ? 1 : cap.tier === "strong" ? 0.85 : cap.tier === "top" ? 0.7 : 0.3;
  if (analysis.difficulty === 4) return cap.tier === "strong" ? 1 : cap.tier === "top" ? 0.95 : cap.tier === "mid" ? 0.5 : 0.15;
  return cap.tier === "top" ? 1 : cap.tier === "strong" ? 0.8 : 0.2; // difficulty 5
}

type ProviderModelInfo_t = Parameters<ProviderAdapter["capabilities"]>[0] extends string
  ? NonNullable<ReturnType<ProviderAdapter["capabilities"]>>
  : never;

/**
 * Decide the routing order.
 * 1. deterministic scoring produces the candidate pool
 * 2. AI decision model (when enabled + reachable) re-ranks the top candidates
 * 3. falls back to deterministic order if AI is unavailable/slow/malformed
 *
 * FREE mode skips the AI re-rank entirely: cost is the binding constraint there
 * and the deterministic cost-weighted score is the only place where live
 * allowance/pricing is factored in. The AI brain sees only names, not quota.
 */
export async function decideRouting(
  ctx: DecisionContext,
  deps: DecisionEngineDeps,
  aiOrder?: string[] | null
): Promise<RoutingDecision> {
  const started = Date.now();
  const { scored, rejected, freeCheapExhausted } = scoreCandidates(ctx);

  // FREE mode, strict policy: no capable cheap candidate exists — refuse to
  // silently spend money. "allow-paid" explicitly permits the expensive pool.
  if (ctx.mode === "free" && freeCheapExhausted && (deps.freeFallbackPolicy ?? "reject") === "reject") {
    return {
      provider: "none",
      model: "none",
      score: 0,
      reason: `no capable free/cheap candidate (difficulty=${ctx.analysis.difficulty}); paid fallback policy=reject`,
      decisionSource: "rules",
      candidates: [],
      rejected,
      decisionLatencyMs: Date.now() - started,
      aiOrder: aiOrder ?? null,
    };
  }

  if (scored.length === 0) {
    const freeBlocked = ctx.mode === "free" && rejected.some((r) => r.reason.includes("free mode"));
    return {
      provider: "none",
      model: "none",
      score: 0,
      reason: freeBlocked
        ? `no capable free/cheap candidate (difficulty=${ctx.analysis.difficulty}); paid fallback policy=${deps.freeFallbackPolicy ?? "reject"}`
        : "no eligible candidates (all filtered by capability/health/quota)",
      decisionSource: "rules",
      candidates: [],
      rejected,
      decisionLatencyMs: Date.now() - started,
      aiOrder: aiOrder ?? null,
    };
  }

  let finalOrder = scored;
  let decisionSource: RoutingDecision["decisionSource"] = "rules";
  let reason = `deterministic ${ctx.mode}-mode scoring`;

  const aiAllowed = ctx.mode !== "free"; // see doc above
  if (aiAllowed && aiOrder && aiOrder.length > 0 && scored.length > 1) {
    const rank = new Map(aiOrder.map((id, i) => [id, i]));
    const known = scored.filter((c) => rank.has(c.model));
    const unknown = scored.filter((c) => !rank.has(c.model));
    known.sort((a, b) => (rank.get(a.model) ?? 99) - (rank.get(b.model) ?? 99));
    if (known.length > 0) {
      finalOrder = [...known, ...unknown].map((c, i) => ({
        ...c,
        score: i === 0 ? c.score : Number((c.score - 0.0001 * i).toFixed(4)),
      }));
      decisionSource = "ai";
      reason = `AI decision model re-ranked top candidates (top pick: ${known[0]?.model ?? "?"})`;
    }
  }

  const top = finalOrder[0]!;
  return {
    provider: top.provider,
    model: top.model,
    score: top.score,
    reason,
    decisionSource,
    candidates: finalOrder.slice(0, 8),
    rejected: rejected.slice(0, 20),
    decisionLatencyMs: Date.now() - started,
    aiOrder: aiOrder ?? null,
  };
}

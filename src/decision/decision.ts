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

/** Max input cost (cents/MTok) that still counts as "cheap-class" free capacity in explicit FREE mode. */
const FREE_CENTS_MAX = 10;

/** Deterministic scoring — always runs, provides the candidate pool + baseline order.
 *
 * Free-tier candidates score their "cost" slot by quota HEADROOM instead of price:
 * cost is uniformly zero on a free tier, so remaining daily allowance is the scarce
 * resource that differentiates them. Paid candidates keep price-based cost scoring.
 */
export function scoreCandidates(
  ctx: DecisionContext,
  options: ScoreOptions = {}
): { scored: ScoredCandidate[]; rejected: Array<{ model: string; reason: string }> } {
  const w = MODE_WEIGHTS[ctx.mode];
  const scored: ScoredCandidate[] = [];
  const rejected: Array<{ model: string; reason: string }> = [];

  const needsTools = ctx.tools.length > 0;
  const needsVision = ctx.analysis.requiresVision;
  const needsContext = ctx.analysis.estimatedPromptTokens + (ctx.analysis.estimatedPromptTokens >> 2); // +25% headroom

  for (const { adapter, state } of ctx.availableProviders) {
    const capacity = state.availableCapacity(adapter.name);
    for (const model of adapter.listModelsSync()) {
      const cap = adapter.capabilities(model);
      if (!cap) continue;

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
      const isFreeCap = cap.free === true;
      // FREE-mode pool: genuine free tiers plus cheap-class capacity (historical
      // "free/cheap candidate" semantics — very low or unknown cost).
      const freePoolEligible =
        isFreeCap ||
        (ctx.mode === "free" && cap.free !== false && (cap.inputCostCentsPerMTok == null || inCost <= FREE_CENTS_MAX));
      const quotaRemaining = isFreeCap ? quotaHeadroom(state, adapter.name) : null;
      // free candidates: cost slot = quota headroom; unknown headroom is neutral
      const costScore = isFreeCap ? quotaRemaining ?? 0.5 : Math.max(0, 1 - inCost / 500);
      const speedScore =
        Math.max(0, 1 - (health.latencyEmaMs ?? 1500) / 6_000) * 0.6 + (cap.tier === "light" ? 0.4 : cap.tier === "mid" ? 0.25 : 0.05);
      const fit = fitScore(ctx.analysis, cap);

      const total = capability * w.capability + costScore * w.cost + speedScore * w.speed + healthScore * w.health + fit * w.fit;

      scored.push({
        provider: adapter.name,
        model,
        score: Number(total.toFixed(4)),
        reasons: [
          `tier=${cap.tier} capability=${capability.toFixed(2)}`,
          isFreeCap
            ? `free-tier${quotaRemaining != null ? ` quota ${Math.round(quotaRemaining * 100)}% left` : ""}`
            : `cost=${inCost}c/MTok`,
          `mode=${ctx.mode}`,
        ],
        free: freePoolEligible || undefined,
        quotaRemaining,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return { scored, rejected };
}

/** 0..1 daily quota headroom for a provider's free tier (null = unknown). */
function quotaHeadroom(state: ProviderStateStore, provider: string): number | null {
  const q = state.quota(provider);
  if (q.dailyRequestsQuota != null && q.dailyRequestsQuota > 0) {
    return Math.max(0, Math.min(1, (q.dailyRequestsQuota - q.requestsToday) / q.dailyRequestsQuota));
  }
  if (q.dailyTokenBudget != null && q.dailyTokenBudget > 0) {
    return Math.max(0, Math.min(1, (q.dailyTokenBudget - q.tokensUsedToday) / q.dailyTokenBudget));
  }
  return null;
}

/** Free-first pool selection: the primary routing policy.
 *
 * - FREE-tier candidates (models on a permanently-free provider tier whose
 *   quota is not exhausted) always form the decision pool when any exist.
 * - When no free candidate survived the hard filters, the PAID pool (puter
 *   best-suited + cheapest via mode weights) takes over — "all quotas over,
 *   switch to puter".
 * - `mode === "free"` is strict: paid is permitted only when the configured
 *   freeFallbackPolicy is "allow-paid"; "reject" refuses to spend instead.
 * - freeFirst disabled + non-free mode → null (legacy all-candidates behavior).
 */
export interface PoolSelection {
  kind: "free" | "paid";
  entries: ScoredCandidate[];
}

export function selectPool(
  scored: ScoredCandidate[],
  mode: RoutingMode,
  opts: { freeFirst: boolean; freeFallbackPolicy: "reject" | "allow-paid" }
): PoolSelection | null {
  const free = scored.filter((c) => c.free === true);
  if (free.length > 0 && (opts.freeFirst || mode === "free")) return { kind: "free", entries: free };

  if (mode === "free") {
    if (opts.freeFallbackPolicy === "allow-paid") return { kind: "paid", entries: scored };
    return { kind: "free", entries: [] }; // strict: refuse to spend (decideRouting rejects)
  }
  if (opts.freeFirst) return { kind: "paid", entries: scored };
  return null;
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
 * 1. deterministic scoring produces the candidate pool (free-aware: free-tier
 *    candidates score quota headroom in the cost slot)
 * 2. free-first pool selection (see selectPool) picks the decision pool
 * 3. AI decision model (when enabled + reachable) re-ranks the pool candidates
 * 4. falls back to deterministic order if AI is unavailable/slow/malformed
 *
 * `pool` is passed by the engine's free-first flow. When omitted (legacy
 * callers / freeFirst disabled), all scored candidates are eligible and the
 * AI re-rank is skipped in free mode (cost is the binding constraint there).
 */
export async function decideRouting(
  ctx: DecisionContext,
  deps: DecisionEngineDeps,
  aiOrder?: string[] | null,
  pool?: PoolSelection | null
): Promise<RoutingDecision> {
  const started = Date.now();
  const { scored, rejected } = scoreCandidates(ctx);

  if (scored.length === 0) {
    return {
      provider: "none",
      model: "none",
      score: 0,
      reason: "no eligible candidates (all filtered by capability/health/quota)",
      decisionSource: "rules",
      candidates: [],
      rejected,
      decisionLatencyMs: Date.now() - started,
      aiOrder: aiOrder ?? null,
    };
  }

  if (pool != null && pool.entries.length === 0) {
    // FREE mode, strict policy: no capable free/cheap candidate exists — refuse
    // to silently spend money. ("allow-paid" is resolved inside selectPool.)
    return {
      provider: "none",
      model: "none",
      score: 0,
      reason: `no capable free/cheap candidate (difficulty=${ctx.analysis.difficulty}); paid fallback policy=${deps.freeFallbackPolicy ?? "reject"}`,
      decisionSource: "rules",
      candidates: [],
      rejected,
      decisionLatencyMs: Date.now() - started,
      aiOrder: aiOrder ?? null,
    };
  }

  const base = pool != null ? pool.entries : scored;
  let finalOrder = base;
  let decisionSource: RoutingDecision["decisionSource"] = "rules";
  let reason =
    pool != null
      ? pool.kind === "free"
        ? `free-first: deterministic scoring over ${base.length} free-tier model(s) with remaining quota`
        : "all free-tier capacity exhausted — paid fallback via deterministic scoring"
      : `deterministic ${ctx.mode}-mode scoring`;

  // FREE mode is the pure-budget path: deterministic scoring only, no AI
  // re-rank (the decision call itself spends money). Other modes re-rank the
  // selected pool (free-first pool included) when the AI layer is reachable.
  const aiAllowed = ctx.mode !== "free";
  if (aiAllowed && aiOrder && aiOrder.length > 0 && base.length > 1) {
    const rank = new Map(aiOrder.map((id, i) => [id, i]));
    const known = base.filter((c) => rank.has(c.model));
    const unknown = base.filter((c) => !rank.has(c.model));
    known.sort((a, b) => (rank.get(a.model) ?? 99) - (rank.get(b.model) ?? 99));
    if (known.length > 0) {
      finalOrder = [...known, ...unknown].map((c, i) => ({
        ...c,
        score: i === 0 ? c.score : Number((c.score - 0.0001 * i).toFixed(4)),
      }));
      decisionSource = "ai";
      const aiPick = `AI decision model re-ranked top candidates (top pick: ${known[0]?.model ?? "?"})`;
      reason =
        pool != null
          ? pool.kind === "free"
            ? `free-first: ${aiPick}`
            : `all free-tier capacity exhausted — paid fallback (${aiPick})`
          : aiPick;
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

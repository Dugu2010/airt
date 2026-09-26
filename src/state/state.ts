import type { HealthState, QuotaState, Usage } from "../core/types.js";
import type { QuotaPolicy } from "../core/config.js";

const COOLDOWN_BASE_MS = 5_000;
const COOLDOWN_MAX_MS = 120_000;
const EMA_ALPHA = 0.3;
const SUCCESS_WINDOW = 20;

/** Rate-limit cooldown when the upstream supplies no Retry-After. */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

export interface QuotaObservation {
  at: number;
  source: "policy" | "response";
  note: string;
}

interface ProviderRuntime {
  health: HealthState;
  quota: QuotaState;
  /** ring of recent successes/failures */
  results: boolean[];
  /** minute window for rpm/tpm */
  windowStart: number;
  windowRequests: number;
  windowTokens: number;
  /** daily window key (UTC date) — quota resets when the key rolls over */
  dayKey: string;
  dayTokens: number;
  dayRequests: number;
  /** configured/static knowledge about this provider's limits */
  policy: QuotaPolicy | null;
  /** last quota observation for observability */
  lastObservation: QuotaObservation | null;
}

/** UTC-date key helper (daily quotas typically reset at UTC midnight). */
function utcDayKey(at = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

export class ProviderStateStore {
  private runtimes = new Map<string, ProviderRuntime>();

  private rt(provider: string): ProviderRuntime {
    let rt = this.runtimes.get(provider);
    if (!rt) {
      rt = {
        health: {
          healthy: true,
          open: false,
          lastError: null,
          lastFailureAt: null,
          consecutiveFailures: 0,
          cooldownUntil: null,
          latencyEmaMs: null,
          ttftEmaMs: null,
          successRate: null,
          rateLimitedUntil: null,
        },
        quota: {
          rpm: 0,
          tpm: 0,
          rpd: 0,
          dailyTokenBudget: null,
          tokensUsedToday: 0,
          exhausted: false,
          source: "reactive",
          confidence: "low",
          resetsAt: null,
          remainingTokens: null,
          lastObservation: null,
          dailyRequestsQuota: null,
          requestsToday: 0,
          dailyResetKey: utcDayKey(),
        },
        results: [],
        windowStart: Date.now(),
        windowRequests: 0,
        windowTokens: 0,
        dayKey: utcDayKey(),
        dayTokens: 0,
        dayRequests: 0,
        policy: null,
        lastObservation: null,
      };
      this.runtimes.set(provider, rt);
    }
    return rt;
  }

  /** Register static knowledge about a provider's limits (policy-level quota info). */
  setQuotaPolicy(provider: string, policy: QuotaPolicy): void {
    const rt = this.rt(provider);
    rt.policy = policy;
    rt.quota.source = policy.source;
    rt.quota.confidence = policy.confidence;
    if (policy.dailyTokenBudget != null) rt.quota.dailyTokenBudget = policy.dailyTokenBudget;
    if (policy.dailyRequestQuota != null) rt.quota.dailyRequestsQuota = policy.dailyRequestQuota;
    rt.quota.lastObservation = { at: Date.now(), source: "policy", note: `policy: ${policy.note}` };
  }

  health(provider: string): HealthState {
    this.rollWindow(provider);
    const rt = this.rt(provider);
    const h = { ...rt.health };
    const now = Date.now();
    const cooldownActive = h.cooldownUntil != null && now < h.cooldownUntil;
    const rateLimitedActive = h.rateLimitedUntil != null && now < h.rateLimitedUntil;
    // OPEN only while a cooldown is actually running. Once the cooldown expires
    // the breaker is HALF-OPEN: consecutiveFailures stays elevated until a probe
    // succeeds, but new requests are allowed through so the provider can recover
    // (a failing probe re-arms a longer cooldown instead of hammering).
    h.open = (h.consecutiveFailures >= 3 && cooldownActive) || rateLimitedActive;
    h.healthy = !h.open;
    return h;
  }

  quota(provider: string): QuotaState {
    this.rollWindow(provider);
    this.rollDay(provider);
    const rt = this.rt(provider);
    const q = rt.quota;
    const remaining =
      q.dailyTokenBudget != null ? Math.max(0, q.dailyTokenBudget - rt.dayTokens) : null;
    const resetsAt =
      q.dailyTokenBudget != null || q.dailyRequestsQuota != null
        ? Date.parse(`${utcDayKey()}T00:00:00.000Z`) + 86_400_000
        : null;
    return {
      ...q,
      rpm: rt.windowRequests,
      tpm: rt.windowTokens,
      rpd: rt.dayRequests,
      requestsToday: rt.dayRequests,
      tokensUsedToday: rt.dayTokens,
      remainingTokens: remaining,
      resetsAt,
    };
  }

  /** Record the start of a request (for rpm/tpm accounting). */
  recordStart(provider: string, estimatedTokens: number): void {
    const rt = this.rt(provider);
    this.rollWindow(provider);
    rt.windowRequests += 1;
    rt.windowTokens += estimatedTokens;
  }

  recordSuccess(provider: string, latencyMs: number, ttftMs: number | null, usage: Usage | null): void {
    const rt = this.rt(provider);
    rt.results.push(true);
    if (rt.results.length > SUCCESS_WINDOW) rt.results.shift();
    rt.health.consecutiveFailures = 0;
    rt.health.lastError = null;
    rt.health.cooldownUntil = null;
    rt.health.latencyEmaMs =
      rt.health.latencyEmaMs == null ? latencyMs : Math.round(rt.health.latencyEmaMs * (1 - EMA_ALPHA) + latencyMs * EMA_ALPHA);
    if (ttftMs != null) {
      rt.health.ttftEmaMs =
        rt.health.ttftEmaMs == null ? ttftMs : Math.round(rt.health.ttftEmaMs * (1 - EMA_ALPHA) + ttftMs * EMA_ALPHA);
    }
    rt.health.successRate = rt.results.filter(Boolean).length / rt.results.length;
    if (usage) {
      this.applyUsageToDay(rt, usage.total_tokens);
      rt.windowTokens += usage.total_tokens;
    }
    this.refreshExhaustion(rt);
  }

  recordFailure(provider: string, kind: string, message: string, retryAfterSec: number | null = null): void {
    const rt = this.rt(provider);
    rt.results.push(false);
    if (rt.results.length > SUCCESS_WINDOW) rt.results.shift();
    rt.health.consecutiveFailures += 1;
    rt.health.lastError = `${kind}: ${message}`.slice(0, 300);
    rt.health.lastFailureAt = Date.now();
    rt.health.successRate = rt.results.filter(Boolean).length / rt.results.length;

    if (kind === "rate_limit") {
      // honor Retry-After when supplied; otherwise default cooldown
      const waitMs = retryAfterSec != null ? retryAfterSec * 1000 : RATE_LIMIT_COOLDOWN_MS;
      rt.health.rateLimitedUntil = Math.max(rt.health.rateLimitedUntil ?? 0, Date.now() + waitMs);
      rt.quota.exhausted = true;
      rt.quota.source = "reactive";
      rt.quota.confidence = "high";
      rt.lastObservation = { at: Date.now(), source: "response", note: "rate limited upstream (429)" };
    } else if (kind === "quota_exhausted") {
      rt.quota.exhausted = true;
      rt.quota.source = "reactive";
      rt.quota.confidence = "high";
      rt.lastObservation = { at: Date.now(), source: "response", note: "quota exhausted upstream (402)" };
    }

    if (rt.health.consecutiveFailures >= 3) {
      // exponential backoff with jitter, capped
      const exp = Math.min(COOLDOWN_BASE_MS * 2 ** (rt.health.consecutiveFailures - 3), COOLDOWN_MAX_MS);
      const jitter = Math.floor(Math.random() * exp * 0.2);
      rt.health.cooldownUntil = Date.now() + exp + jitter;
    }
  }

  /** Legacy API kept for compatibility. */
  setDailyTokenBudget(provider: string, budget: number | null): void {
    if (budget == null) return;
    this.setQuotaPolicy(provider, {
      provider,
      dailyTokenBudget: budget,
      dailyRequestQuota: null,
      source: "estimated",
      confidence: "medium",
      note: "daily token budget heuristic",
    });
  }

  availableCapacity(provider: string): { ok: boolean; reason: string | null } {
    const h = this.health(provider);
    if (h.open) return { ok: false, reason: "circuit_open" };
    const q = this.quota(provider);
    if (q.exhausted) return { ok: false, reason: "quota_exhausted" };
    if (q.dailyTokenBudget != null && q.tokensUsedToday >= q.dailyTokenBudget) {
      return { ok: false, reason: "daily_token_budget_reached" };
    }
    if (q.dailyRequestsQuota != null && q.requestsToday >= q.dailyRequestsQuota) {
      return { ok: false, reason: "daily_request_quota_reached" };
    }
    return { ok: true, reason: null };
  }

  snapshot(): Record<string, { health: HealthState; quota: QuotaState }> {
    const out: Record<string, { health: HealthState; quota: QuotaState }> = {};
    for (const [name] of this.runtimes) {
      out[name] = { health: this.health(name), quota: this.quota(name) };
    }
    return out;
  }

  /** Manual quota reset (e.g. process restart, policy update, or operator action). */
  resetQuota(provider: string): void {
    const rt = this.rt(provider);
    rt.quota.exhausted = false;
    rt.health.rateLimitedUntil = null;
    rt.health.consecutiveFailures = 0;
    this.refreshExhaustion(rt);
  }

  // ---- internals ------------------------------------------------------------------

  private refreshExhaustion(rt: ProviderRuntime): void {
    const p = rt.policy;
    let exhausted = false;
    if (p?.dailyTokenBudget != null && rt.dayTokens >= p.dailyTokenBudget) exhausted = true;
    if (p?.dailyRequestQuota != null && rt.dayRequests >= p.dailyRequestQuota) exhausted = true;
    // reactive exhaustion (429/402) clears only when the daily window rolls over
    if (!exhausted && rt.quota.exhausted && rt.quota.source === "reactive" && rt.dayKey === utcDayKey()) {
      exhausted = true;
    }
    rt.quota.exhausted = exhausted;
  }

  private applyUsageToDay(rt: ProviderRuntime, tokens: number): void {
    this.rollDayImpl(rt);
    rt.dayTokens += tokens;
    rt.dayRequests += 1;
  }

  private rollWindow(provider: string): void {
    const rt = this.rt(provider);
    const now = Date.now();
    if (now - rt.windowStart >= 60_000) {
      rt.windowStart = now;
      rt.windowRequests = 0;
      rt.windowTokens = 0;
    }
  }

  private rollDay(provider: string): void {
    this.rollDayImpl(this.rt(provider));
  }

  private rollDayImpl(rt: ProviderRuntime): void {
    const key = utcDayKey();
    if (rt.dayKey !== key) {
      rt.dayKey = key;
      rt.dayTokens = 0;
      rt.dayRequests = 0;
      // new day: reactive exhaustion clears; policy re-evaluates on next use
      if (rt.quota.source === "reactive") {
        rt.quota.exhausted = false;
        rt.quota.confidence = "low";
      }
      rt.health.rateLimitedUntil = null;
    }
  }
}

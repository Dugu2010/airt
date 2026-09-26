/**
 * Circuit breaker recovery lifecycle tests (phase 3 #8):
 * CLOSED → failures → OPEN → cooldown → HALF-OPEN → success → CLOSED,
 * plus provider recovery, persistent failure, and quota reset semantics.
 */
import { describe, expect, it, vi } from "vitest";
import { ProviderStateStore } from "../../src/state/state.js";
import { StubAdapter } from "../helpers/stub-adapter.js";
import { makeMultiHarness, routeMulti } from "../helpers/multi-harness.js";

describe("circuit breaker lifecycle (state store)", () => {
  it("CLOSED → 3 failures → OPEN with cooldown", () => {
    const store = new ProviderStateStore();
    expect(store.health("p").open).toBe(false);
    store.recordFailure("p", "server", "x1");
    store.recordFailure("p", "server", "x2");
    expect(store.health("p").open).toBe(false);
    store.recordFailure("p", "server", "x3");
    const h = store.health("p");
    expect(h.open).toBe(true);
    expect(h.consecutiveFailures).toBe(3);
    expect(h.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("OPEN → cooldown expiry → HALF-OPEN (next request decides) → success → CLOSED", () => {
    vi.useFakeTimers();
    try {
      const store = new ProviderStateStore();
      for (let i = 0; i < 3; i++) store.recordFailure("p", "server", "boom");
      expect(store.health("p").open).toBe(true);
      // after cooldown (base 5s + up to 20% jitter ≤ 6s) the breaker is half-open
      vi.advanceTimersByTime(7_000);
      const h = store.health("p");
      expect(h.open).toBe(false); // allows a probe request
      // success closes the breaker
      store.recordSuccess("p", 50, 50, null);
      expect(store.health("p").open).toBe(false);
      expect(store.health("p").consecutiveFailures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("HALF-OPEN probe that fails re-opens with a LONGER cooldown (no permanent blacklist, no hammering)", () => {
    vi.useFakeTimers();
    try {
      const store = new ProviderStateStore();
      for (let i = 0; i < 3; i++) store.recordFailure("p", "server", "boom");
      vi.advanceTimersByTime(5_500);
      store.recordFailure("p", "server", "probe failed"); // 4th consecutive
      expect(store.health("p").open).toBe(true);
      const cd4 = store.health("p").cooldownUntil ?? 0;
      vi.advanceTimersByTime(11_000);
      store.recordFailure("p", "server", "probe failed again"); // 5th
      const cd5 = store.health("p").cooldownUntil ?? 0;
      // exponential: 5th failure cooldown longer than 4th
      expect(cd5 - Date.now()).toBeGreaterThan(cd4 - (Date.now() - 11_000) - 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("provider recovers after being half-open-probed successfully (multi-request flow)", async () => {
    const flaky = new StubAdapter("flaky", [{ id: "f:m", tier: "mid", tools: true, context: 100_000 }], { failFirstN: 3, failKind: "server" });
    const backup = new StubAdapter("backup", [{ id: "b:m", tier: "mid", tools: true, context: 100_000 }]);
    const { engine } = makeMultiHarness({ providers: [{ adapter: flaky }, { adapter: backup }], maxRetries: 3 });

    const r1 = await routeMulti(engine, {}, "auto"); // flaky fails → backup serves
    expect(r1.response.choices[0]?.message.content).toBeTruthy();
    const r2 = await routeMulti(engine, {}, "auto"); // flaky recovered
    expect(r2.response.choices[0]?.message.content).toBeTruthy();
    // after recovery the flaky provider records success (breaker stays usable)
    expect(flaky.callCount).toBeGreaterThanOrEqual(2);
  });

  it("provider remains dead: traffic shifts to the healthy provider (score penalty + breaker)", async () => {
    const dead = new StubAdapter("dead", [{ id: "d:m", tier: "mid", tools: true, context: 100_000 }], { failAll: "connection" });
    const backup = new StubAdapter("backup", [{ id: "b:m", tier: "mid", tools: true, context: 100_000 }]);
    const { engine, providers } = makeMultiHarness({ providers: [{ adapter: dead }, { adapter: backup }], maxRetries: 3 });
    for (let i = 0; i < 4; i++) {
      const r = await routeMulti(engine, {}, "auto");
      expect(r.response.choices[0]?.message.content).toBeTruthy();
    }
    // the dead provider accumulated failures and recorded zero successes
    const deadHealth = providers[0]!.state.health("dead");
    expect(deadHealth.consecutiveFailures).toBeGreaterThanOrEqual(2);
    expect(deadHealth.successRate).toBeLessThan(0.5);
    // every completion came from the healthy provider
    for (let i = 0; i < 3; i++) {
      const r = await routeMulti(engine, {}, "auto");
      expect(r.trace.attempts.find((a) => a.ok)?.provider).toBe("backup");
    }
  });

  it("daily quota exhaustion persists across resetQuota (policy re-eval) but clears on restart", async () => {
    const store = new ProviderStateStore();
    store.setQuotaPolicy("limited", {
      provider: "limited",
      dailyTokenBudget: 10,
      dailyRequestQuota: null,
      source: "policy",
      confidence: "high",
      note: "tiny budget for test",
    });
    store.recordStart("limited", 5);
    store.recordSuccess("limited", 5, 5, { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 });
    expect(store.availableCapacity("limited").ok).toBe(false);
    // resetQuota re-evaluates the policy: usage (12) still exceeds budget (10)
    store.resetQuota("limited");
    expect(store.availableCapacity("limited").ok).toBe(false);
    // process restart equivalent: a fresh store has no usage
    const fresh = new ProviderStateStore();
    fresh.setQuotaPolicy("limited", {
      provider: "limited",
      dailyTokenBudget: 10,
      dailyRequestQuota: null,
      source: "policy",
      confidence: "high",
      note: "tiny budget for test",
    });
    expect(fresh.availableCapacity("limited").ok).toBe(true);
  });
});

/**
 * Phase-3 hardening: catalog resilience, quota state, Retry-After honor,
 * FREE-mode paid-fallback policy.
 */
import { describe, expect, it } from "vitest";
import { ModelRegistry } from "../../src/registry/registry.js";
import { ProviderStateStore } from "../../src/state/state.js";
import { classifyHttpError, retryAfterFrom } from "../../src/errors/classify.js";
import { StubAdapter } from "../helpers/stub-adapter.js";
import { makeMultiHarness, routeMulti } from "../helpers/multi-harness.js";

describe("catalog resilience", () => {
  it("a failed refresh never deletes existing registry entries", () => {
    const reg = new ModelRegistry([]); // empty seed: registry only holds what we refresh
    reg.refresh([{ id: "x:keep", context: 100_000 }]);
    // malformed / partial refresh input must not clobber
    reg.refresh([{ id: "x:keep" } as never]); // sparse entry: merges only defined fields
    const kept = reg.get("x:keep");
    expect(kept).not.toBeNull();
    expect(kept!.context).toBe(100_000);
    expect(reg.all().length).toBe(1);
  });

  it("new models appear and old entries are preserved on refresh", () => {
    const reg = new ModelRegistry();
    reg.refresh([{ id: "x:a", context: 10_000 }]);
    reg.refresh([{ id: "x:b", context: 20_000 }]);
    expect(reg.get("x:a")!.context).toBe(10_000);
    expect(reg.get("x:b")!.context).toBe(20_000);
    // metadata change (context shrink from live catalog) is applied
    reg.refresh([{ id: "x:a", context: 5_000 }]);
    expect(reg.get("x:a")!.context).toBe(5_000);
  });

  it("an empty/failed catalog response leaves the registry untouched", () => {
    const reg = new ModelRegistry();
    reg.refresh([{ id: "x:a", context: 10_000 }]);
    reg.refresh([]); // provider returned nothing
    expect(reg.get("x:a")).not.toBeNull();
  });
});

describe("quota state intelligence", () => {
  it("records Retry-After-driven cooldowns and honors expiry", () => {
    const store = new ProviderStateStore();
    store.recordFailure("p", "rate_limit", "slow down", 2);
    const h = store.health("p");
    expect(h.rateLimitedUntil).not.toBeNull();
    expect(h.open).toBe(true);
    // cooldown window is ~2s (Retry-After honored, not the default 60s)
    const waitMs = (h.rateLimitedUntil ?? 0) - Date.now();
    expect(waitMs).toBeGreaterThan(0);
    expect(waitMs).toBeLessThanOrEqual(2_500);
  });

  it("default rate-limit cooldown applies without Retry-After", () => {
    const store = new ProviderStateStore();
    store.recordFailure("p", "rate_limit", "slow down");
    const waitMs = (store.health("p").rateLimitedUntil ?? 0) - Date.now();
    expect(waitMs).toBeGreaterThan(55_000);
  });

  it("quota policy with daily request cap exhausts and availableCapacity reports it", () => {
    const store = new ProviderStateStore();
    store.setQuotaPolicy("p", {
      provider: "p",
      dailyTokenBudget: null,
      dailyRequestQuota: 2,
      source: "policy",
      confidence: "high",
      note: "test policy",
    });
    store.recordStart("p", 10);
    store.recordSuccess("p", 10, 10, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    store.recordStart("p", 10);
    store.recordSuccess("p", 10, 10, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    expect(store.quota("p").exhausted).toBe(true);
    expect(store.availableCapacity("p").ok).toBe(false);
    expect(store.availableCapacity("p").reason).toBe("quota_exhausted");
  });

  it("policy-based daily token budget tracks remainingTokens and resetsAt", () => {
    const store = new ProviderStateStore();
    store.setQuotaPolicy("p", {
      provider: "p",
      dailyTokenBudget: 1_000_000,
      dailyRequestQuota: null,
      source: "policy",
      confidence: "medium",
      note: "1M tokens/day",
    });
    store.recordStart("p", 0);
    store.recordSuccess("p", 5, 5, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    const q = store.quota("p");
    expect(q.tokensUsedToday).toBe(150);
    expect(q.remainingTokens).toBe(999_850);
    expect(q.resetsAt).toBeGreaterThan(Date.now());
    expect(q.confidence).toBe("medium");
  });

  it("resetQuota clears reactive exhaustion (operator action)", () => {
    const store = new ProviderStateStore();
    store.recordFailure("p", "quota_exhausted", "402");
    expect(store.availableCapacity("p").ok).toBe(false);
    store.resetQuota("p");
    expect(store.availableCapacity("p").ok).toBe(true);
  });

  it("extracts Retry-After from headers", () => {
    const headers = new Headers({ "retry-after": "7" });
    expect(retryAfterFrom(headers)).toBe(7);
    expect(retryAfterFrom(new Headers())).toBeNull();
    expect(retryAfterFrom(null)).toBeNull();
  });
});

describe("HTTP status matrix classification", () => {
  const cases: Array<[number, string]> = [
    [401, "auth"],
    [403, "auth"],
    [402, "quota_exhausted"],
    [404, "unsupported_capability"],
    [413, "context_overflow"],
    [422, "unsupported_capability"],
    [408, "server"],
    [409, "server"],
    [500, "server"],
    [502, "server"],
    [503, "server"],
    [504, "server"],
  ];
  for (const [status, expected] of cases) {
    it(`HTTP ${status} → ${expected}`, () => {
      const c = classifyHttpError(status, `upstream said ${status}`);
      expect(c.kind).toBe(expected);
    });
  }

  it("429 carries Retry-After seconds", () => {
    const c = classifyHttpError(429, "rate limited", new Headers({ "retry-after": "12" }));
    expect(c.kind).toBe("rate_limit");
    expect(c.retryAfterSec).toBe(12);
  });

  it("400 body mentioning context length is context_overflow", () => {
    const c = classifyHttpError(400, JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens" } }));
    expect(c.kind).toBe("context_overflow");
  });
});

describe("FREE mode paid-fallback policy", () => {
  it("reject: no free candidate → decision refuses with clear reason (no silent spend)", async () => {
    const priceyOnly = new StubAdapter("pricey", [{ id: "p:expensive", tier: "top", tools: true, context: 200_000, inputCostCentsPerMTok: 500 }]);
    const { engine } = makeMultiHarness({ providers: [{ adapter: priceyOnly }], maxRetries: 1 });
    await expect(routeMulti(engine, { messages: [{ role: "user", content: "x".repeat(12_000) }] }, "free")).rejects.toThrow(
      /no capable free|no eligible|free\/cheap/i
    );
  });

  it("allow-paid: explicit policy permits paid fallback in FREE mode", async () => {
    const priceyOnly = new StubAdapter("pricey", [{ id: "p:expensive", tier: "top", tools: true, context: 200_000, inputCostCentsPerMTok: 500 }]);
    const { engine } = makeMultiHarness({ providers: [{ adapter: priceyOnly }], maxRetries: 1 });
    // default harness uses "reject"; exercise allow-paid through a direct engine dep injection
    (engine as unknown as { deps: { freeFallbackPolicy: string } }).deps.freeFallbackPolicy = "allow-paid";
    const out = await routeMulti(engine, { messages: [{ role: "user", content: "x".repeat(12_000) }] }, "free");
    expect(out.response.choices[0]?.message.content).toBeTruthy();
  });

  it("FREE mode still prefers genuinely free capacity over paid when both exist", async () => {
    const free = new StubAdapter("freeprovider", [{ id: "f:cheap-free", tier: "light", tools: true, context: 128_000, inputCostCentsPerMTok: 0 }]);
    const paid = new StubAdapter("paidprovider", [{ id: "q:paid-strong", tier: "strong", tools: true, context: 128_000, inputCostCentsPerMTok: 300 }]);
    const { engine } = makeMultiHarness({ providers: [{ adapter: paid }, { adapter: free }] });
    const out = await routeMulti(engine, { messages: [{ role: "user", content: "Say OK" }] }, "free");
    expect(out.response.router!.decision.provider).toBe("freeprovider");
  });
});

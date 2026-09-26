/**
 * Free-first routing policy (ROUTER_FREE_FIRST, default on):
 * - any capable free-tier model with non-exhausted quota forms the decision
 *   pool ahead of paid capacity, in every mode except strict FREE
 * - free candidates rank on remaining daily quota in the cost slot
 * - when all free capacity is exhausted/filtered, the paid pool takes over
 *   (puter best+cheapest via mode weights)
 * - disabling freeFirst restores legacy all-candidate deterministic scoring
 */
import { describe, expect, it } from "vitest";
import type { ProviderStateStore } from "../../src/state/state.js";
import { StubAdapter } from "../helpers/stub-adapter.js";
import { makeMultiHarness, routeMulti } from "../helpers/multi-harness.js";

const FREE = [
  { id: "groq:llama-3.1-8b-instant", tier: "light" as const, tools: true, context: 128_000, inputCostCentsPerMTok: 0, free: true },
];
const PAID = [
  { id: "puter:gpt-5.6-sol", tier: "top" as const, tools: true, context: 200_000, inputCostCentsPerMTok: 400 },
];

/** Apply a daily request quota and burn N requests against it. */
function burnRequests(store: ProviderStateStore, provider: string, used: number, quota: number): void {
  store.setQuotaPolicy(provider, {
    provider,
    dailyTokenBudget: null,
    dailyRequestQuota: quota,
    source: "policy",
    confidence: "high",
    note: "test",
  });
  for (let i = 0; i < used; i++) {
    store.recordStart(provider, 10);
    store.recordSuccess(provider, 10, 10, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  }
}

describe("free-first routing", () => {
  it("auto mode picks a free-tier model over a higher-scoring paid model", async () => {
    const groq = new StubAdapter("groq", FREE, {});
    const puter = new StubAdapter("puter", PAID, {});
    const { engine } = makeMultiHarness({ providers: [{ adapter: puter }, { adapter: groq }] });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.trace.decision.provider).toBe("groq");
    expect(out.trace.decision.reason).toMatch(/free-first/);
    expect(out.trace.decision.candidates.every((c) => c.provider === "groq")).toBe(true);
  });

  it("all free capacity exhausted → paid (puter) fallback takes over", async () => {
    const groq = new StubAdapter("groq", FREE, {});
    const puter = new StubAdapter("puter", PAID, {});
    const { providers, engine } = makeMultiHarness({ providers: [{ adapter: groq }, { adapter: puter }] });
    providers[0]!.state.recordFailure("groq", "quota_exhausted", "daily free quota exhausted");
    const out = await routeMulti(engine, {}, "auto");
    expect(out.trace.decision.provider).toBe("puter");
    expect(out.trace.decision.reason).toMatch(/all free-tier capacity exhausted/);
  });

  it("free candidates rank by remaining daily quota (scarcer provider loses)", async () => {
    const scarce = new StubAdapter("groq", [{ ...FREE[0]!, id: "groq:scarce-model" }], {});
    const ample = new StubAdapter("openrouter", [{ ...FREE[0]!, id: "openrouter:ample-model" }], {});
    const { providers, engine } = makeMultiHarness({ providers: [{ adapter: scarce }, { adapter: ample }] });
    burnRequests(providers[0]!.state, "groq", 75, 100); // 25% left
    burnRequests(providers[1]!.state, "openrouter", 10, 100); // 90% left
    const out = await routeMulti(engine, {}, "auto");
    expect(out.trace.decision.model).toBe("openrouter:ample-model");
    expect(out.trace.decision.candidates[0]?.reasons.join(" ")).toMatch(/quota 90% left/);
  });

  it("nearly-exhausted free capacity (1% left) is still picked before paid", async () => {
    const groq = new StubAdapter("groq", FREE, {});
    const puter = new StubAdapter("puter", PAID, {});
    const { providers, engine } = makeMultiHarness({ providers: [{ adapter: groq }, { adapter: puter }] });
    burnRequests(providers[0]!.state, "groq", 99, 100);
    const out = await routeMulti(engine, {}, "auto");
    expect(out.trace.decision.provider).toBe("groq");
    expect(out.trace.decision.candidates[0]?.reasons.join(" ")).toMatch(/quota 1% left/);
  });

  it("ROUTER_FREE_FIRST=0 (freeFirst disabled) keeps legacy all-candidate scoring", async () => {
    const groq = new StubAdapter("groq", FREE, {});
    const puter = new StubAdapter("puter", PAID, {});
    const { engine } = makeMultiHarness({ providers: [{ adapter: groq }, { adapter: puter }], freeFirst: false });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.trace.decision.provider).toBe("puter"); // pure score: top tier wins
    expect(out.trace.decision.reason).not.toMatch(/free-first|capacity exhausted/);
  });

  it("free provider fails in-flight → failover falls back to paid capacity", async () => {
    const groq = new StubAdapter("groq", FREE, { failAll: "rate_limit" });
    const puter = new StubAdapter("puter", PAID, {});
    const { engine } = makeMultiHarness({ providers: [{ adapter: groq }, { adapter: puter }] });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.trace.attempts[0]?.provider).toBe("groq");
    expect(out.trace.attempts[0]?.ok).toBe(false);
    expect(out.response.router!.decision.provider).toBe("puter");
    expect(out.response.router!.decision.reason).toMatch(/failover from/);
  });
});

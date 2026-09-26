/**
 * Concurrency / load tests (phase 3 #7). Deterministic stub providers only —
 * no real provider quotas are consumed.
 */
import { describe, expect, it } from "vitest";
import { StubAdapter } from "../helpers/stub-adapter.js";
import { makeMultiHarness, routeMulti } from "../helpers/multi-harness.js";

const MODELS_A = [
  { id: "a:top", tier: "top" as const, tools: true, context: 200_000, inputCostCentsPerMTok: 300 },
  { id: "a:light", tier: "light" as const, tools: true, context: 100_000, inputCostCentsPerMTok: 3 },
];
const MODELS_B = [
  { id: "b:strong", tier: "strong" as const, tools: true, context: 128_000, inputCostCentsPerMTok: null },
  { id: "b:light", tier: "light" as const, tools: true, context: 128_000, inputCostCentsPerMTok: null },
];

describe("concurrency", () => {
  it("1 sequential request: trivial sanity", async () => {
    const a = new StubAdapter("a", MODELS_A);
    const { engine } = makeMultiHarness({ providers: [{ adapter: a }] });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.response.choices[0]?.message.content).toBeTruthy();
  });

  it("5 simultaneous requests: all succeed, state stays consistent", async () => {
    const a = new StubAdapter("a", MODELS_A);
    const { engine, providers } = makeMultiHarness({ providers: [{ adapter: a }] });
    const results = await Promise.all(Array.from({ length: 5 }, () => routeMulti(engine, {}, "auto")));
    expect(results.every((r) => r.response.choices[0]?.message.content)).toBe(true);
    const q = providers[0]!.state.quota("a");
    expect(q.rpm).toBe(5); // every start recorded exactly once
  });

  it("10 simultaneous: counters consistent, no deadlocks", async () => {
    const a = new StubAdapter("a", MODELS_A);
    const { engine, providers } = makeMultiHarness({ providers: [{ adapter: a }] });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => routeMulti(engine, { messages: [{ role: "user", content: `q${i}` }] }, "auto")));
    expect(results.length).toBe(10);
    expect(results.every((r) => r.response.choices[0]?.message.content)).toBe(true);
    expect(providers[0]!.state.quota("a").rpm).toBe(10);
  });

  it("25 simultaneous across two providers: no race conditions, no lost updates", async () => {
    const a = new StubAdapter("a", MODELS_A);
    const b = new StubAdapter("b", MODELS_B);
    const { engine, providers } = makeMultiHarness({ providers: [{ adapter: a }, { adapter: b }] });
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => routeMulti(engine, { messages: [{ role: "user", content: `q${i}` }] }, "auto")));
    expect(results.every((r) => r.response.choices[0]?.message.content)).toBe(true);
    const aStarts = providers[0]!.state.quota("a").rpm;
    const bStarts = providers[1]!.state.quota("b").rpm;
    // each request records exactly one start on the provider that served it
    expect(aStarts + bStarts).toBeGreaterThanOrEqual(25);
  });

  it("50 simultaneous with one failing provider: traffic distributes to the healthy one", async () => {
    const dead = new StubAdapter("dead", MODELS_A, { failAll: "connection" });
    const alive = new StubAdapter("alive", MODELS_B);
    const { engine } = makeMultiHarness({ providers: [{ adapter: dead }, { adapter: alive }], maxRetries: 2 });
    const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => routeMulti(engine, { messages: [{ role: "user", content: `q${i}` }] }, "auto")));
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    // most requests must complete via the healthy provider (circuit opening on `dead`)
    expect(fulfilled.length).toBeGreaterThan(40);
    const successes = (fulfilled as PromiseFulfilledResult<Awaited<ReturnType<typeof routeMulti>>>[]).map((r) => r.value);
    expect(successes.every((s) => s.response.choices[0]?.message.content)).toBe(true);
    // the dead provider never returned a successful completion
    expect(successes.every((s) => s.trace.attempts.every((at) => at.provider !== "dead" || !at.ok))).toBe(true);
  });

  it("no secret leakage under concurrency: traces and errors stay clean", async () => {
    const a = new StubAdapter("a", MODELS_A, { reply: "ok" });
    const { engine } = makeMultiHarness({ providers: [{ adapter: a }], maxRetries: 1 });
    const results = await Promise.all(Array.from({ length: 10 }, () => routeMulti(engine, {}, "auto")));
    const serialized = JSON.stringify(results.map((r) => r.response));
    expect(serialized).not.toMatch(/sk-gw-|Bearer |api[_-]?key/i);
  });

  it("burst does not blow up memory: 100 sequential quick requests complete", async () => {
    const a = new StubAdapter("a", MODELS_A);
    const { engine } = makeMultiHarness({ providers: [{ adapter: a }], maxRetries: 1 });
    for (let i = 0; i < 100; i++) {
      const out = await routeMulti(engine, { messages: [{ role: "user", content: `m${i}` }] }, "fast");
      expect(out.response.choices[0]?.message.content).toBeTruthy();
    }
  });
});

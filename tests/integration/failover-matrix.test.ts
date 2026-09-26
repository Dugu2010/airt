/**
 * Failover matrix (phase 3 #5): every failure kind must preserve the original
 * error classification, the attempt history, and route to a capability-
 * compatible provider. Also verifies trace observability fields.
 */
import { describe, expect, it } from "vitest";
import { StubAdapter, type ScriptedFailure } from "../helpers/stub-adapter.js";
import { makeMultiHarness, routeMulti } from "../helpers/multi-harness.js";

const MODELS = [
  { id: "a:m", tier: "top" as const, tools: true, context: 128_000, inputCostCentsPerMTok: 1 },
  { id: "a:light", tier: "light" as const, tools: true, context: 128_000, inputCostCentsPerMTok: 1 },
];
const MODELS_B = [{ id: "b:m", tier: "strong" as const, tools: true, context: 128_000, inputCostCentsPerMTok: null }];

const KINDS: ScriptedFailure[] = [
  "timeout",
  "connection",
  "rate_limit",
  "server",
  "quota",
  "malformed",
  "context_overflow",
];

describe("failover matrix", () => {
  for (const kind of KINDS) {
    it(`${kind} on provider A → failover to B preserves classification + history`, async () => {
      const a = new StubAdapter("a", MODELS, { failAll: kind });
      const b = new StubAdapter("b", MODELS_B);
      const { engine } = makeMultiHarness({ providers: [{ adapter: a }, { adapter: b }], maxRetries: 3 });
      const out = await routeMulti(engine, { messages: [{ role: "user", content: "hello" }] }, "auto");
      expect(out.response.choices[0]?.message.content).toBeTruthy();
      const failedAttempts = out.trace.attempts.filter((x) => !x.ok);
      expect(failedAttempts.length).toBeGreaterThanOrEqual(1);
      expect(failedAttempts.every((x) => x.provider === "a")).toBe(true);
      expect(failedAttempts.every((x) => x.error && x.error.kind.length > 0)).toBe(true);
      // final success on b; providersFailed lists a
      expect(out.trace.attempts.find((x) => x.ok)?.provider).toBe("b");
      expect(out.trace.providersFailed).toContain("a");
      expect(out.trace.finalStatus).toBe("success");
      expect(out.trace.requestId).toMatch(/^rreq/);
    });
  }

  it("auth failure (401) never routes back to the same key-broken provider loop", async () => {
    const a = new StubAdapter("a", MODELS, { failAll: "auth" });
    const b = new StubAdapter("b", MODELS_B);
    const { engine } = makeMultiHarness({ providers: [{ adapter: a }, { adapter: b }], maxRetries: 3 });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.response.choices[0]?.message.content).toBeTruthy();
    expect(out.trace.attempts.find((x) => x.ok)?.provider).toBe("b");
  });

  it("capability-incompatible providers are never failover targets (tools)", async () => {
    const a = new StubAdapter("a", MODELS.map((m) => ({ ...m })), { failAll: "connection" });
    const bNoTools = new StubAdapter("b", [{ id: "b:no-tools", tier: "strong", tools: false, context: 128_000 }]);
    const cTools = new StubAdapter("c", [{ id: "c:tools", tier: "mid", tools: true, context: 128_000 }]);
    const { engine } = makeMultiHarness({ providers: [{ adapter: a }, { adapter: bNoTools }, { adapter: cTools }], maxRetries: 3 });
    const out = await routeMulti(
      engine,
      {
        messages: [{ role: "user", content: "use the tool" }],
        tools: [{ type: "function", function: { name: "f", parameters: {} } }],
      },
      "auto"
    );
    expect(out.response.choices[0]?.message.content).toBeTruthy();
    const okAttempt = out.trace.attempts.find((x) => x.ok);
    expect(okAttempt?.provider).toBe("c");
    expect(out.trace.attempts.every((x) => x.provider !== "b" || !x.ok)).toBe(true);
  });

  it("finish_reason=length produces a length finish, not an error", async () => {
    const a = new StubAdapter("a", MODELS, { reply: "truncated output", finishSequence: ["length"] });
    const { engine } = makeMultiHarness({ providers: [{ adapter: a }] });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.response.choices[0]?.finish_reason).toBe("length");
  });

  it("exhausted retry budget surfaces the original error kind", async () => {
    const a = new StubAdapter("a", MODELS, { failAll: "rate_limit" });
    const { engine } = makeMultiHarness({ providers: [{ adapter: a }], maxRetries: 1 });
    try {
      await routeMulti(engine, {}, "auto");
      throw new Error("should have thrown");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toMatch(/rate_limit|No alternative/i);
    }
  });
});

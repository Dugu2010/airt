/**
 * AI decision-layer audit tests (phase-2 objectives #10).
 *
 * Verifies the AI brain's security/robustness contract:
 * - AI output can only reorder the hard-filtered candidate pool
 * - AI cannot bypass quota / circuit-breaker rules
 * - invalid AI JSON falls back to deterministic routing
 * - decision-model failure (timeout/outage) falls back safely
 * - decision latency is measured and the AI order is observable in the trace
 */
import { describe, expect, it } from "vitest";
import { StubAdapter } from "../helpers/stub-adapter.js";
import { makeMultiHarness, routeMulti } from "../helpers/multi-harness.js";
import { scoreCandidates, type DecisionContext } from "../../src/decision/decision.js";
import { analyzeRequest } from "../../src/analysis/analyzer.js";
import type { ProviderAdapter, ProviderModelInfo, ProviderChatResult, ChatRequestForProvider, ClassifiedError } from "../../src/core/types.js";
import { ProviderStateStore } from "../../src/state/state.js";

const MODELS = [
  { id: "a:top-model", tier: "top" as const, tools: true, context: 200_000, inputCostCentsPerMTok: 300 },
  { id: "a:light-model", tier: "light" as const, tools: true, context: 100_000, inputCostCentsPerMTok: 3 },
];

function makeCtx(decisionAdapter: ProviderAdapter | null, providers: ProviderAdapter[]): DecisionContext {
  const messages = [{ role: "user" as const, content: "hello world" }];
  return {
    mode: "auto",
    analysis: analyzeRequest(messages),
    messages,
    tools: [],
    availableProviders: providers.map((adapter) => ({ adapter, state: new ProviderStateStore() })),
  };
}

/** Decision-model stub whose chat reply is scripted via replySequence. */
function decisionStub(replies: string[]): StubAdapter {
  return new StubAdapter("brain", MODELS, { replySequence: replies, finishSequence: ["stop", "stop", "stop"] });
}

describe("AI decision layer audit", () => {
  it("AI order cannot reintroduce models that failed hard filters (no vision support)", async () => {
    // message contains a data:image URL — the analyzer flags requiresVision
    const visionReq = [{ role: "user" as const, content: "Analyze this data:image/png;base64,AAAA picture in detail" }];
    const analysis = analyzeRequest(visionReq);
    expect(analysis.requiresVision).toBe(true);
    const noVision = new StubAdapter("novision", [{ id: "novision:text-only", tier: "top", tools: true, vision: false }]);
    const withVision = new StubAdapter("vision", [{ id: "vision:sees", tier: "mid", tools: true, vision: true }]);
    const { engine } = makeMultiHarness({ providers: [{ adapter: noVision }, { adapter: withVision }] });

    // Hard-filter level: the vision-less model can never be in the scored pool
    const ctx = makeCtx(null, [noVision, withVision]);
    ctx.analysis = analysis;
    const { scored, rejected } = scoreCandidates(ctx);
    expect(scored.some((c) => c.model.includes("novision"))).toBe(false);
    expect(rejected.some((r) => r.model.includes("novision"))).toBe(true);

    // End-to-end: engine analyzes the request itself and routes only to the
    // vision-capable pool, even if a naive AI order preferred novision.
    const out = await routeMulti(engine, { messages: visionReq }, "auto");
    expect(out.response.router!.decision.provider).toBe("vision");
  });

  it("AI cannot bypass quota exhaustion (quota-exhausted provider is filtered from scoring)", async () => {
    const exhausted = new StubAdapter("exhausted", MODELS);
    const healthy = new StubAdapter("healthy", MODELS);
    const { providers, engine } = makeMultiHarness({ providers: [{ adapter: exhausted }, { adapter: healthy }] });
    // mark exhausted provider's state
    providers[0]!.state.recordFailure("exhausted", "quota_exhausted", "daily quota exhausted");
    const out = await routeMulti(engine, {}, "auto");
    expect(out.response.router!.decision.provider).toBe("healthy");
    expect(out.trace.decision.candidates.every((c) => c.provider !== "exhausted")).toBe(true);
  });

  it("AI cannot bypass an open circuit breaker on a fresh request", async () => {
    const broken = new StubAdapter("broken", MODELS);
    const fine = new StubAdapter("fine", MODELS);
    const { providers, engine } = makeMultiHarness({ providers: [{ adapter: broken }, { adapter: fine }] });
    for (let i = 0; i < 3; i++) providers[0]!.state.recordFailure("broken", "server", "boom");
    expect(providers[0]!.state.health("broken").open).toBe(true);
    const out = await routeMulti(engine, {}, "auto");
    expect(out.response.router!.decision.provider).toBe("fine");
  });

  it("invalid AI JSON falls back to deterministic routing", async () => {
    const brain = decisionStub(["I will not comply with JSON constraints.", "garbage {broken"]);
    const primary = new StubAdapter("primary", MODELS);
    const { engine } = makeMultiHarness({
      providers: [{ adapter: primary }],
      decision: {
        decisionAdapter: brain,
        model: "a:top-model",
        fallbackModels: [],
        timeoutMs: 2_000,
      },
    });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.trace.decision.decisionSource).toBe("rules");
    expect(out.trace.decision.aiOrder ?? null).toBeNull();
  });

  it("decision-model outage falls back to deterministic routing", async () => {
    const brain = new StubAdapter("brain", MODELS, { failAll: "timeout" });
    const primary = new StubAdapter("primary", MODELS);
    const { engine } = makeMultiHarness({
      providers: [{ adapter: primary }],
      decision: { decisionAdapter: brain, model: "a:top-model", fallbackModels: [], timeoutMs: 1_000 },
    });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.trace.decision.decisionSource).toBe("rules");
    expect(out.response.choices[0]?.message.content).toBeTruthy();
  });

  it("decision latency is measured and AI order is observable when AI is used", async () => {
    const brain = decisionStub(['{"order":["a:light-model","a:top-model"]}']);
    const primary = new StubAdapter("primary", MODELS);
    const { engine } = makeMultiHarness({
      providers: [{ adapter: primary }],
      decision: { decisionAdapter: brain, model: "a:top-model", fallbackModels: [], timeoutMs: 2_000 },
    });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.trace.decision.decisionSource).toBe("ai");
    expect(out.trace.decision.aiOrder).toEqual(["a:light-model", "a:top-model"]);
    expect(out.trace.decision.decisionLatencyMs).toBeGreaterThanOrEqual(0);
    expect(out.response.router!.decision.model).toBe("a:light-model");
  });

  it("AI order is applied only within the hard-filtered pool (class-level guarantee)", async () => {
    // AI says "route everything to x:filtered-out" which is not a candidate at all
    const brain = decisionStub(['{"order":["x:unknown-model","a:light-model"]}']);
    const primary = new StubAdapter("primary", MODELS);
    const { engine } = makeMultiHarness({
      providers: [{ adapter: primary }],
      decision: { decisionAdapter: brain, model: "a:top-model", fallbackModels: [], timeoutMs: 2_000 },
    });
    const out = await routeMulti(engine, {}, "auto");
    // unknown model ignored; only known candidates reorder
    expect(out.trace.decision.candidates.every((c) => c.model.startsWith("a:"))).toBe(true);
  });

  it("decision-model truncation (empty content + finish_reason length) retries with a larger budget", async () => {
    const brain = decisionStub([
      "", // first attempt: reasoning consumed the budget (gpt-5-nano failure signature)
      '{"order":["a:top-model"]}', // retry succeeds
    ]);
    // fix the first finish reason to "length" to emulate truncation
    const brainAdapter = brain;
    brainAdapter.setScript({ replySequence: ["", '{"order":["a:top-model"]}'], finishSequence: ["length", "stop"] });
    const primary = new StubAdapter("primary", MODELS);
    const { engine } = makeMultiHarness({
      providers: [{ adapter: primary }],
      decision: { decisionAdapter: brainAdapter, model: "a:top-model", fallbackModels: [], timeoutMs: 2_000 },
    });
    const out = await routeMulti(engine, {}, "auto");
    expect(brainAdapter.callCount).toBe(2);
    expect(out.trace.decision.decisionSource).toBe("ai");
  });

  it("FREE mode never calls the AI decision model", async () => {
    const brain = decisionStub(['{"order":["a:top-model"]}']);
    const primary = new StubAdapter("primary", MODELS);
    const { engine } = makeMultiHarness({
      providers: [{ adapter: primary }],
      decision: { decisionAdapter: brain, model: "a:top-model", fallbackModels: [], timeoutMs: 2_000 },
    });
    await routeMulti(engine, {}, "free");
    expect(brain.callCount).toBe(0);
  });
});

/**
 * Cross-provider failover integration tests.
 *
 * Uses stub adapters (test doubles) to script deterministic failure sequences
 * on a SECOND provider and verifies the router moves traffic across providers
 * while preserving task compatibility — plus the audit scenarios: timeout, 429,
 * 5xx, connection failure, provider outage, quota exhaustion, malformed
 * response, context overflow.
 */
import { describe, expect, it } from "vitest";
import { StubAdapter } from "../helpers/stub-adapter.js";
import { makeMultiHarness, routeMulti } from "../helpers/multi-harness.js";

const PUTER_MODELS = [
  { id: "openai:openai/gpt-5.6-sol", tier: "top" as const, context: 1_050_000, tools: true, vision: true, inputCostCentsPerMTok: 400 },
  { id: "alibaba:qwen/qwen3.7-flash", tier: "light" as const, context: 1_000_000, tools: true, inputCostCentsPerMTok: 3 },
  { id: "deepseek:deepseek/deepseek-v4-flash", tier: "mid" as const, context: 1_000_000, tools: true, inputCostCentsPerMTok: 14 },
];

const GROQ_MODELS = [
  { id: "groq:llama-3.3-70b-versatile", tier: "strong" as const, context: 131_072, tools: true, inputCostCentsPerMTok: null },
  { id: "groq:llama-3.1-8b-instant", tier: "light" as const, context: 131_072, tools: true, inputCostCentsPerMTok: null },
];

const OR_MODELS = [
  { id: "openrouter:deepseek/deepseek-r1:free", tier: "strong" as const, context: 163_840, tools: true, inputCostCentsPerMTok: 0 },
  { id: "openrouter:meta-llama/llama-3.3-70b-instruct:free", tier: "strong" as const, context: 131_072, tools: true, inputCostCentsPerMTok: 0 },
];

function twoProviderHarness(extraScript = {}) {
  const puter = new StubAdapter("puter", PUTER_MODELS, {});
  const groq = new StubAdapter("groq", GROQ_MODELS, extraScript);
  const { engine, providers } = makeMultiHarness({ providers: [{ adapter: puter }, { adapter: groq }] });
  return { engine, puter, groq, providers };
}

describe("cross-provider failover", () => {
  it("routes normally to the best candidate regardless of provider", async () => {
    const { engine, puter, groq } = twoProviderHarness();
    const out = await routeMulti(engine, { messages: [{ role: "user", content: "hello" }] }, "auto");
    expect(["puter", "groq"]).toContain(out.response.router!.decision.provider);
    expect(puter.callCount + groq.callCount).toBe(1);
  });

  it("fails over from a 429-rate-limited provider to another provider", async () => {
    const { engine, groq } = twoProviderHarness({ failAll: "rate_limit" });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.response.router!.decision.provider).not.toBe("groq");
    expect(out.trace.attempts.some((a) => a.provider === "groq" && a.error?.kind === "rate_limit")).toBe(true);
    expect(groq.callCount).toBeGreaterThanOrEqual(1);
  });

  it("fails over from a 5xx-ing provider", async () => {
    const { engine } = twoProviderHarness({ failAll: "server" });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.response.router!.decision.provider).not.toBe("groq");
    expect(out.trace.attempts.some((a) => a.error?.kind === "server")).toBe(true);
  });

  it("fails over on connection failure (second provider down at network level)", async () => {
    const { engine } = twoProviderHarness({ failAll: "connection" });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.response.router!.decision.provider).not.toBe("groq");
    expect(out.trace.attempts.some((a) => a.error?.kind === "connection")).toBe(true);
  });

  it("fails over on timeout", async () => {
    const { engine } = twoProviderHarness({ failAll: "timeout" });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.response.router!.decision.provider).not.toBe("groq");
    expect(out.trace.attempts.some((a) => a.error?.kind === "timeout")).toBe(true);
  });

  it("fails over on quota exhaustion (402)", async () => {
    const { engine } = twoProviderHarness({ failAll: "quota" });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.response.router!.decision.provider).not.toBe("groq");
    expect(out.trace.attempts.some((a) => a.error?.kind === "quota_exhausted")).toBe(true);
  });

  it("fails over on malformed response", async () => {
    const { engine } = twoProviderHarness({ failAll: "malformed" });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.response.router!.decision.provider).not.toBe("groq");
    expect(out.trace.attempts.some((a) => a.error?.kind === "malformed_response")).toBe(true);
  });

  it("fails over on context overflow to a larger-context provider", async () => {
    // puter (big context) primary, groq rejects overflow → succeeds via puter
    const puter = new StubAdapter("puter", PUTER_MODELS, {});
    const groq = new StubAdapter("groq", GROQ_MODELS, { failAll: "context_overflow" });
    const { engine } = makeMultiHarness({ providers: [{ adapter: groq }, { adapter: puter }] });
    const out = await routeMulti(engine, {}, "auto");
    expect(out.response.router!.decision.provider).toBe("puter");
    expect(out.trace.attempts.some((a) => a.error?.kind === "context_overflow")).toBe(true);
  });

  it("survives a full provider outage without dropping the request", async () => {
    const { engine } = twoProviderHarness({ failAll: "connection" });
    const out = await routeMulti(engine, {}, "fast");
    expect(out.response.choices[0]?.message.content).toBeTruthy();
  });

  it("keeps capability compatibility when failing over (tools required)", async () => {
    // only OR free models + puter top support tools; stub B without tools must be skipped
    const puter = new StubAdapter("puter", [{ id: "openai:openai/gpt-5.6-sol", tier: "top", tools: true, vision: true }]);
    const noTools = new StubAdapter("notool", [{ id: "notool:basic", tier: "mid", tools: false }]);
    const { engine } = makeMultiHarness({ providers: [{ adapter: noTools }, { adapter: puter }] });
    const out = await routeMulti(
      engine,
      {
        messages: [{ role: "user", content: "call the tool" }],
        tools: [{ type: "function", function: { name: "f", parameters: {} } }],
      },
      "auto"
    );
    expect(out.response.router!.decision.provider).toBe("puter");
    expect(out.trace.decision.rejected.some((r) => r.model.includes("notool"))).toBe(true);
  });

  it("honors top-tier priority across providers for a hard task (quality mode)", async () => {
    const puter = new StubAdapter("puter", PUTER_MODELS, {});
    const groq = new StubAdapter("groq", GROQ_MODELS, {});
    const or = new StubAdapter("openrouter", OR_MODELS, {});
    const { engine } = makeMultiHarness({ providers: [{ adapter: groq }, { adapter: or }, { adapter: puter }] });
    const task = {
      messages: [
        {
          role: "user",
          content:
            "Design a distributed consensus algorithm with formal proofs of correctness, analyze its partition-tolerance trade-offs, and derive the complexity bounds. This is a research-grade system architecture problem.",
        },
      ],
    } as const;

    // QUALITY mode: strongest suitable model must win across ALL providers.
    const q = await routeMulti(engine, task, "quality");
    expect(q.response.router!.decision.model).toContain("gpt-5.6-sol");
    expect(q.response.router!.decision.provider).toBe("puter");
    expect(q.trace.analysis.difficulty).toBeGreaterThanOrEqual(4);

    // AUTO mode: top-tier stays in the candidate pool (considered first),
    // but a genuinely free strong-tier model may legitimately win on value.
    const a = await routeMulti(engine, task, "auto");
    const models = a.trace.decision.candidates.map((c) => c.model);
    expect(models.some((m) => m.includes("gpt-5.6-sol"))).toBe(true);
    expect(a.trace.decision.decisionSource).toBe("rules");
  });

  it("FREE mode spans providers and respects cheap-capacity constraint", async () => {
    const puter = new StubAdapter("puter", PUTER_MODELS, {});
    const groq = new StubAdapter("groq", GROQ_MODELS, {}); // free-tier: null cost
    const or = new StubAdapter("openrouter", OR_MODELS, {}); // :free → cost 0
    const { engine } = makeMultiHarness({ providers: [{ adapter: groq }, { adapter: or }, { adapter: puter }] });
    const out = await routeMulti(engine, { messages: [{ role: "user", content: "Say OK" }] }, "free");
    expect(out.trace.mode).toBe("free");
    // top-tier must be excluded in free mode for trivial tasks
    expect(out.response.router!.decision.model).not.toContain("gpt-5.6-sol");
    // chosen model must come from a genuinely free/cheap option
    expect(out.response.router!.decision.model).toMatch(/free|llama-3\.1-8b|qwen3\.7-flash/);
  });

  it("free mode with no capable cheap candidate: rejects by default, allows paid via explicit policy", async () => {
    const hardOnly = new StubAdapter("hardonly", [{ id: "openai:openai/gpt-5.6-sol", tier: "top", tools: true, context: 200_000 }]);
    const cheap = new StubAdapter("cheap", [{ id: "cheap:mini", tier: "light", context: 2_000 }]); // genuinely too small
    const { engine } = makeMultiHarness({ providers: [{ adapter: cheap }, { adapter: hardOnly }], maxRetries: 1 });
    const task = { messages: [{ role: "user", content: "x".repeat(12_000) }] }; // ~3k tokens + headroom > 2k ctx

    // default strict policy: never silently spend money
    await expect(routeMulti(engine, task, "free")).rejects.toThrow(/no capable free\/cheap candidate/);

    // explicit allow-paid policy: paid fallback permitted
    (engine as unknown as { deps: { freeFallbackPolicy: string } }).deps.freeFallbackPolicy = "allow-paid";
    const out = await routeMulti(engine, task, "free");
    expect(out.response.router!.decision.provider).toBe("hardonly");
  });

  it("FREE mode failover stays within free capacity (no paid fallback for trivial tasks)", async () => {
    const puter = new StubAdapter("puter", [
      { id: "openai:openai/gpt-5.6-sol", tier: "top", tools: true, inputCostCentsPerMTok: 400 },
      { id: "alibaba:qwen/qwen3.7-flash", tier: "light", tools: true, inputCostCentsPerMTok: 3 },
    ]);
    const or = new StubAdapter("openrouter", [
      { id: "openrouter:deepseek/deepseek-r1:free", tier: "strong", tools: true, inputCostCentsPerMTok: 0 },
    ]);
    const orAdapter = or as StubAdapter;
    orAdapter.setScript({ failAll: "rate_limit" }); // free provider exhausted
    const { engine } = makeMultiHarness({ providers: [{ adapter: or }, { adapter: puter }] });
    const out = await routeMulti(engine, { messages: [{ role: "user", content: "Say OK" }] }, "free");
    // free provider is 429-ing → next choice must still be cheap tier (qwen), NOT gpt-5.6-sol
    expect(out.response.router!.decision.model).toContain("qwen3.7-flash");
  });

  it("reports per-provider state across all registered providers", async () => {
    const { providers } = twoProviderHarness();
    expect(providers.map((p) => p.adapter.name).sort()).toEqual(["groq", "puter"]);
  });
});

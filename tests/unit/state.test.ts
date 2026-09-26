import { describe, expect, it } from "vitest";
import { ProviderStateStore } from "../../src/state/state.js";
import { scoreCandidates, decideRouting } from "../../src/decision/decision.js";
import { ModelRegistry, PUTER_REGISTRY_SEED } from "../../src/registry/registry.js";
import type { DecisionContext, } from "../../src/decision/decision.js";
import type { ProviderAdapter, TaskAnalysis, RoutingMode } from "../../src/core/types.js";

function makeAnalysis(partial: Partial<TaskAnalysis>): TaskAnalysis {
  return {
    primary: "chat",
    secondary: [],
    difficulty: 2,
    requiresTools: false,
    requiresVision: false,
    requiresLongContext: false,
    requiresReasoning: false,
    estimatedPromptTokens: 100,
    signals: [],
    ...partial,
  };
}

const makeCtx = (opts: {
  mode?: RoutingMode;
  analysis?: TaskAnalysis;
  tools?: number;
  registry?: ModelRegistry;
  state?: ProviderStateStore;
}): DecisionContext => {
  const registry = opts.registry ?? new ModelRegistry();
  const state = opts.state ?? new ProviderStateStore();
  const adapter: ProviderAdapter = {
    name: "puter",
    listModels: async () => registry.all(),
    listModelsSync: () => registry.all().map((m) => m.id),
    capabilities: (m) => registry.get(m),
    contextLimit: (m) => registry.get(m)?.context ?? 128_000,
    healthCheck: async () => true,
    quota: () => state.quota("puter"),
    supports: () => true,
    chat: async () => ({ message: { role: "assistant", content: "ok" }, finishReason: "stop", usage: null }),
    stream: async () => {
      async function* empty() {}
      return empty();
    },
    classifyError: () => ({ kind: "unknown", status: null, message: "", retryable: false, switchProvider: true }),
  };
  return {
    mode: opts.mode ?? "auto",
    analysis: opts.analysis ?? makeAnalysis({}),
    messages: [{ role: "user", content: "hello" }],
    tools: Array.from({ length: opts.tools ?? 0 }, (_, i) => ({
      type: "function" as const,
      function: { name: `tool${i}`, parameters: {} },
    })),
    availableProviders: [{ adapter, state }],
  };
};

describe("ProviderStateStore", () => {
  it("starts healthy with no circuit open", () => {
    const s = new ProviderStateStore();
    const h = s.health("puter");
    expect(h.healthy).toBe(true);
    expect(h.open).toBe(false);
  });

  it("opens circuit after 3 consecutive failures and cools down", () => {
    const s = new ProviderStateStore();
    for (let i = 0; i < 3; i++) s.recordFailure("puter", "server", "err");
    const h = s.health("puter");
    expect(h.consecutiveFailures).toBe(3);
    expect(h.open).toBe(true);
    expect(h.healthy).toBe(false);
    expect(h.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("marks rate limited and sets quota exhausted", () => {
    const s = new ProviderStateStore();
    s.recordFailure("puter", "rate_limit", "slow down");
    expect(s.health("puter").rateLimitedUntil).toBeGreaterThan(Date.now());
    expect(s.quota("puter").exhausted).toBe(true);
    expect(s.availableCapacity("puter").ok).toBe(false);
  });

  it("recovers on success", () => {
    const s = new ProviderStateStore();
    for (let i = 0; i < 3; i++) s.recordFailure("puter", "server", "err");
    s.recordSuccess("puter", 500, 200, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    const h = s.health("puter");
    expect(h.consecutiveFailures).toBe(0);
    expect(h.open).toBe(false);
    expect(h.latencyEmaMs).toBe(500);
    expect(s.quota("puter").tokensUsedToday).toBe(15);
  });

  it("tracks rpm window", async () => {
    const s = new ProviderStateStore();
    s.recordStart("puter", 100);
    s.recordStart("puter", 100);
    expect(s.quota("puter").rpm).toBe(2);
    expect(s.quota("puter").tpm).toBe(200);
  });
});

describe("scoreCandidates", () => {
  it("produces scored candidates with top-tier favored in quality mode", () => {
    const ctx = makeCtx({ mode: "quality" });
    const { scored, rejected } = scoreCandidates(ctx);
    expect(scored.length).toBeGreaterThan(10);
    expect(rejected.length).toBe(0);
    // In quality mode, capability dominates → top/strong tier should lead over light tier
    const top5 = scored.slice(0, 5).map((c) => c.model);
    expect(top5.some((m) => /gpt-5\.6|gpt-6|opus|gemini-3\.8|sonnet-5/.test(m))).toBe(true);
    // light models must NOT win quality mode outright
    const winner = new ModelRegistry().get(scored[0]!.model);
    expect(winner?.tier === "light").toBe(false);
  });

  it("free mode favors cheap models", () => {
    const ctx = makeCtx({ mode: "free" });
    const { scored } = scoreCandidates(ctx);
    const top = scored[0]!.model;
    // cheapest light-tier model (qwen3.7-flash at 3c/MTok) should win or be near-top
    expect(top).toMatch(/qwen3\.7-flash|qwen-flash|gpt-5-nano/);
  });

  it("filters non-vision models when vision required", () => {
    const ctx = makeCtx({
      mode: "auto",
      analysis: makeAnalysis({ requiresVision: true }),
    });
    const { scored, rejected } = scoreCandidates(ctx);
    expect(scored.every((c) => {
      const reg = new ModelRegistry();
      return reg.get(c.model)?.vision ?? false;
    })).toBe(true);
    expect(rejected.some((r) => r.reason.includes("vision"))).toBe(true);
  });

  it("filters non-tool models when tools required", () => {
    const ctx = makeCtx({ mode: "auto", tools: 2 });
    const { scored, rejected } = scoreCandidates(ctx);
    expect(rejected.some((r) => r.reason.includes("tool"))).toBe(true);
    // deepseek-r1 has tools=false in seed → must be rejected
    expect(scored.every((c) => !c.model.includes("deepseek-r1"))).toBe(true);
  });

  it("eliminates models with insufficient context for huge prompts", () => {
    const ctx = makeCtx({
      mode: "auto",
      analysis: makeAnalysis({ estimatedPromptTokens: 500_000 }),
    });
    const { scored, rejected } = scoreCandidates(ctx);
    expect(scored.every((c) => {
      const reg = new ModelRegistry();
      return (reg.get(c.model)?.context ?? 0) >= 500_000;
    })).toBe(true);
    expect(rejected.some((r) => r.reason.includes("context"))).toBe(true);
    // small-context models (gpt-4o-mini at 128k) must be gone
    expect(scored.every((c) => c.model !== "openai:openai/gpt-4o-mini")).toBe(true);
  });

  it("excludes providers with open circuits", () => {
    const state = new ProviderStateStore();
    for (let i = 0; i < 4; i++) state.recordFailure("puter", "server", "down");
    const ctx = makeCtx({ mode: "auto", state });
    const { scored, rejected } = scoreCandidates(ctx);
    expect(scored).toHaveLength(0);
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]!.reason).toContain("circuit_open");
  });
});

describe("decideRouting", () => {
  it("returns deterministic order without AI", async () => {
    const ctx = makeCtx({ mode: "balanced" });
    const d = await decideRouting(ctx, { rulesOnly: true });
    expect(d.decisionSource).toBe("rules");
    expect(d.candidates.length).toBeGreaterThan(3);
  });

  it("applies AI re-ranking when provided", async () => {
    const ctx = makeCtx({ mode: "auto" });
    const { scored } = scoreCandidates(ctx);
    const lastModel = scored[scored.length - 1]!.model;
    const d = await decideRouting(ctx, {}, [lastModel, scored[0]!.model]);
    expect(d.decisionSource).toBe("ai");
    expect(d.model).toBe(lastModel);
    expect(d.reason).toContain("AI decision model");
  });

  it("ignores AI order with unknown models only", async () => {
    const ctx = makeCtx({ mode: "auto" });
    const d = await decideRouting(ctx, {}, ["nonexistent:model/xyz"]);
    expect(d.decisionSource).toBe("rules");
  });

  it("reports empty decision when everything is filtered", async () => {
    const state = new ProviderStateStore();
    for (let i = 0; i < 4; i++) state.recordFailure("puter", "rate_limit", "429");
    const ctx = makeCtx({ mode: "auto", state });
    const d = await decideRouting(ctx, { rulesOnly: true });
    expect(d.provider).toBe("none");
  });
});

describe("registry", () => {
  it("seeds known models with correct tiers", () => {
    const reg = new ModelRegistry();
    expect(reg.get("openai:openai/gpt-5.6-sol")?.tier).toBe("top");
    expect(reg.get("alibaba:qwen/qwen3.7-flash")?.tier).toBe("light");
  });

  it("refresh overrides context from live catalog without changing tier", () => {
    const reg = new ModelRegistry();
    reg.refresh([{ id: "openai:openai/gpt-5.6-sol", context: 999_999 }]);
    const m = reg.get("openai:openai/gpt-5.6-sol");
    expect(m?.context).toBe(999_999);
    expect(m?.tier).toBe("top");
  });

  it("refresh adds unknown models with inferred tier", () => {
    const reg = new ModelRegistry();
    reg.refresh([{ id: "vendor:new/model", context: 32_000, inputCostCentsPerMTok: 8 }]);
    expect(reg.get("vendor:new/model")?.tier).toBe("light");
  });

  it("seed includes at least 20 models", () => {
    expect(PUTER_REGISTRY_SEED.length).toBeGreaterThanOrEqual(20);
  });
});

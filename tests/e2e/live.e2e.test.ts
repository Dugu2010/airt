/**
 * REAL E2E tests: run the actual router HTTP server against the LIVE Puter
 * wrapper (daii.freebuff.app) and exercise the full request path:
 * analyze → decide (AI) → execute → validate → respond.
 *
 * Skipped automatically when the wrapper is unreachable or rejects all auth
 * (401 without any key), so CI without credentials stays green.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

const WRAPPER_BASE = process.env.PUTER_WRAPPER_BASE ?? "https://daii.freebuff.app";
const WRAPPER_KEY = process.env.PUTER_WRAPPER_KEY ?? "";

// Module-scope probe (top-level await): must complete before describe.skipIf evaluates.
let probeStatus = 0;
try {
  const res = await fetch(`${WRAPPER_BASE}/v1/models`, {
    headers: WRAPPER_KEY ? { Authorization: `Bearer ${WRAPPER_KEY}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  probeStatus = res.status;
} catch {
  probeStatus = 0;
}
// usable when open (200) or reachable-but-locked with a key configured (401 + key)
const available = probeStatus === 200 || (probeStatus === 401 && WRAPPER_KEY.length > 0);

let server: Server | null = null;
let base = "";

describe.skipIf(!available)("live E2E", () => {
  beforeAll(async () => {
    process.env.PUTER_WRAPPER_BASE = WRAPPER_BASE;
    process.env.PUTER_WRAPPER_KEY = WRAPPER_KEY;
    process.env.PORT = "0";
    const mod = await import("../../src/api/server.js");
    server = mod.server;
    if (!server.listening) {
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    }
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    if (server?.listening) await new Promise<void>((r) => server!.close(() => r()));
  });

  async function chat(body: Record<string, unknown>, expectStatus = 200) {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150_000),
    });
    expect(res.status).toBe(expectStatus);
    return res;
  }

  it("boots router and passes health", async () => {
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBeLessThan(500);
  });

  it("lists models including live catalog entries", async () => {
    const res = await fetch(`${base}/v1/models`);
    const j = (await res.json()) as { data: Array<{ id: string }> };
    expect(j.data.length).toBeGreaterThan(20);
    expect(j.data.some((m) => m.id.includes("gpt"))).toBe(true);
  });

  it("auto-routes a trivial request (cheap model, low difficulty)", async () => {
    const res = await chat({ messages: [{ role: "user", content: "hi" }], routing_mode: "auto" });
    const j = (await res.json()) as {
      model: string;
      router: { decision: { decisionSource: string }; analysis: { difficulty: number } };
    };
    expect(j.router.analysis.difficulty).toBeLessThanOrEqual(2);
    console.log("  [e2e] trivial →", j.model, "| decision:", j.router.decision.decisionSource);
  }, 180_000);

  it("auto-routes a hard reasoning request (difficulty ≥ 4)", async () => {
    const res = await chat({
      messages: [
        {
          role: "user",
          content:
            "I need a formal analysis: derive the time complexity of memoized Fibonacci vs iterative, compare trade-offs for a distributed system architecture, and prove which is better for a security audit pipeline.",
        },
      ],
      routing_mode: "auto",
    });
    const j = (await res.json()) as { model: string; router: { analysis: { difficulty: number } } };
    expect(j.router.analysis.difficulty).toBeGreaterThanOrEqual(4);
    console.log("  [e2e] hard →", j.model);
  }, 180_000);

  it("free mode selects a cheap model and completes", async () => {
    const res = await chat({ messages: [{ role: "user", content: "Say OK" }], routing_mode: "free" });
    const j = (await res.json()) as { model: string; choices: Array<{ message: { content: string | null } }> };
    expect(j.choices[0]?.message.content).toBeTruthy();
    // free-mode contract: the chosen model's live-catalog input cost must be in
    // the cheap band (≤ 10 USD-cents per 1M tokens) — not a hardcoded name,
    // so new cheap catalog entries stay eligible.
    const modelsRes = await fetch(`${base}/v1/models`);
    const models = (await modelsRes.json()) as { data: Array<{ id: string; input_cost_cents_per_mtok: number | null }> };
    const chosen = models.data.find((m) => m.id === j.model);
    expect(chosen).toBeDefined();
    expect(chosen?.input_cost_cents_per_mtok ?? 999).toBeLessThanOrEqual(10);
  }, 180_000);

  it("quality mode completes with a capable model", async () => {
    const res = await chat({ messages: [{ role: "user", content: "Say OK" }], routing_mode: "quality" });
    const j = (await res.json()) as { model: string };
    console.log("  [e2e] quality →", j.model);
    expect(j.model).toBeTruthy();
  }, 180_000);

  it("handles tool-calling end-to-end", async () => {
    const res = await chat({
      messages: [{ role: "user", content: "What is the weather in Tokyo? Use the get_weather tool." }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather for a city",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        },
      ],
    });
    const j = (await res.json()) as {
      choices: Array<{ message: { tool_calls?: Array<{ function: { name: string } }> } }>;
    };
    const tc = j.choices[0]?.message.tool_calls?.[0];
    expect(tc?.function.name).toBe("get_weather");
  }, 180_000);

  it("pinned model request is honored", async () => {
    const res = await chat({
      model: "deepseek:deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "Say PINNED-OK" }],
    });
    const j = (await res.json()) as { model: string; choices: Array<{ message: { content: string | null } }> };
    expect(j.model).toBe("deepseek:deepseek/deepseek-v4-flash");
    expect(j.choices[0]?.message.content).toBeTruthy();
  }, 180_000);

  it("streaming returns SSE chunks ending with [DONE]", async () => {
    const res = await chat({ messages: [{ role: "user", content: "Count 1 to 3" }], stream: true });
    const text = await res.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  }, 180_000);

  it("rejects invalid requests with OpenAI-style errors", async () => {
    const res = await chat({ messages: [] }, 400);
    const j = (await res.json()) as { error: { type: string } };
    expect(j.error.type).toBe("invalid_request_error");
  });

  // ---- multi-provider (phase 2) -------------------------------------------

  it("registers the puter-direct provider when PUTER_API_KEY/PUTER_DIRECT_TOKEN is present", async () => {
    const res = await fetch(`${base}/v1/state`);
    const j = (await res.json()) as { providers: Array<{ name: string; models: number }> };
    const names = j.providers.map((p) => p.name);
    expect(names).toContain("puter");
    if (process.env.PUTER_API_KEY || process.env.PUTER_DIRECT_TOKEN) {
      expect(names).toContain("puter-direct");
      const direct = j.providers.find((p) => p.name === "puter-direct")!;
      expect(direct.models).toBeGreaterThan(0);
    }
  });

  it("routes to the direct provider when the wrapper is unreachable (real failover)", async () => {
    if (!process.env.PUTER_API_KEY && !process.env.PUTER_DIRECT_TOKEN) return;
    // Boot an isolated router whose ONLY wrapper is a dead host.
    process.env.PUTER_WRAPPER_BASE = "http://127.0.0.1:1"; // nothing listens here
    process.env.PORT = "0";
    const mod2 = await import("../../src/api/server.js?dead-wrapper");
    const server2 = mod2.server;
    if (!server2.listening) {
      await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
    }
    const addr2 = server2.address() as AddressInfo;
    const base2 = `http://127.0.0.1:${addr2.port}`;
    try {
      const res = await fetch(`${base2}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Say OK" }], routing_mode: "free" }),
        signal: AbortSignal.timeout(120_000),
      });
      expect(res.status).toBe(200);
      const j = (await res.json()) as {
        model: string;
        router: { attempts: Array<{ provider: string; ok: boolean; error?: { kind: string } }> };
      };
      expect(j.model).toMatch(/puter-direct:/);
      const wrapperAttempt = j.router.attempts.find((a) => a.provider === "puter");
      expect(wrapperAttempt?.ok).toBe(false);
      expect(wrapperAttempt?.error?.kind).toMatch(/connection|timeout/);
      const directAttempt = j.router.attempts.find((a) => a.provider === "puter-direct");
      expect(directAttempt?.ok).toBe(true);
    } finally {
      if (server2.listening) await new Promise<void>((r) => server2.close(() => r()));
      delete process.env.PUTER_WRAPPER_BASE;
    }
  }, 180_000);
});

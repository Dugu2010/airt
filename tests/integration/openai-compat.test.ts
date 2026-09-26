/**
 * Wire-contract tests for the OpenAI-compatible adapters (Groq, OpenRouter).
 *
 * These providers have no credentials in this workspace, so live verification is
 * impossible. Instead this suite proves the adapters against a local mock server
 * that speaks the OpenAI wire protocol exactly as the providers' documented APIs
 * do: /models discovery shape, /chat/completions request/response shape, error
 * classification matrix, and SSE streaming. When real credentials appear, the
 * scripts/probe-multi.ts probe provides the live smoke test; until then these
 * tests are the contract guard for the adapters' HTTP behavior.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { ModelRegistry } from "../../src/registry/registry.js";
import { ClassifiedUpstreamError } from "../../src/errors/classify.js";
import { GroqAdapter } from "../../src/providers/groq.js";
import { OpenRouterAdapter } from "../../src/providers/openrouter.js";
import type { ProviderModelInfo } from "../../src/core/types.js";

// ---- mock OpenAI-compatible upstream ---------------------------------------

interface CapturedRequest {
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

let server: Server | null = null;
let base = "";
const captured: CapturedRequest[] = [];
let mode:
  | "normal"
  | "rate-limit"
  | "auth"
  | "quota"
  | "context-overflow"
  | "server-error"
  | "not-found"
  | "malformed-json"
  | "missing-message"
  | "retry-after" = "normal";

const GROQ_MODELS = {
  object: "list",
  data: [
    { id: "llama-3.3-70b-versatile", context_window: 131072, max_completion_tokens: 32768, supports_tool_use: true },
    { id: "llama-3.1-8b-instant", context_window: 131072, max_completion_tokens: 8192, supports_tool_use: true },
    { id: "gpt-oss-120b", context_window: 131072, supports_tool_use: true },
    { id: "whisper-large-v3", context_window: 432, supports_tool_use: false },
  ],
};

const OPENROUTER_MODELS = {
  data: [
    {
      id: "deepseek/deepseek-chat-v3.1:free",
      context_length: 163840,
      supported_parameters: ["tools", "max_tokens"],
      pricing: { prompt: "0", completion: "0" },
      architecture: { input_modalities: ["text"] },
    },
    {
      id: "openai/gpt-5.6-sol",
      context_length: 400000,
      supported_parameters: ["tools"],
      pricing: { prompt: "0.0000015", completion: "0.000006" },
      architecture: { input_modalities: ["text", "image"] },
    },
    {
      id: "google/gemini-2.5-flash-image",
      context_length: 1048576,
      supported_parameters: [],
      pricing: { prompt: "0.0000003", completion: "0.0000025" },
      architecture: { input_modalities: ["text", "image"] },
    },
  ],
};

function sse(chunks: string[], finish = "stop", withUsage = true): string {
  const lines: string[] = [];
  for (const c of chunks) {
    lines.push(
      `data: ${JSON.stringify({ id: "cmpl-x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: c } }] })}`
    );
  }
  if (withUsage) {
    lines.push(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: chunks.join("").length } })}`
    );
  }
  lines.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}`);
  lines.push("data: [DONE]");
  return lines.map((l) => `${l}\n\n`).join("");
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // undici pools sockets; an unexpected socket close mid-keep-alive surfaces as
  // UND_ERR_SOCKET instead of the response we want, so disable keep-alive.
  res.setHeader("Connection", "close");
  const auth = req.headers.authorization ?? null;
  let body: Record<string, unknown> | null = null;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }

  if (req.url?.endsWith("/models")) {
    captured.push({ path: req.url, auth, body: null });
    if (mode === "auth") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API key", code: "invalid_api_key" } }));
      return;
    }
    const payload = req.url.includes("groq") ? GROQ_MODELS : OPENROUTER_MODELS;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.url?.endsWith("/chat/completions")) {
    captured.push({ path: req.url, auth, body });
    const fail = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    switch (mode) {
      case "rate-limit":
        return fail(429, { error: { message: "Rate limit reached for model", code: "rate_limit_exceeded" } });
      case "retry-after":
        return fail(429, { error: { message: "Rate limit reached" } }, { "Retry-After": "30" });
      case "auth":
        return fail(401, { error: { message: "Invalid API key", code: "invalid_api_key" } });
      case "quota":
        return fail(402, { error: { message: "Insufficient credits / quota exceeded" } });
      case "context-overflow":
        return fail(400, { error: { message: "This model's maximum context length is 8192 tokens" } });
      case "server-error":
        return fail(503, { error: { message: "The server had an error processing your request" } });
      case "not-found":
        return fail(404, { error: { message: "The model `x` does not exist" } });
      case "malformed-json":
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("this is not json{");
        return;
      case "missing-message":
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "cmpl-1", choices: [{ index: 0, finish_reason: "stop" }] }));
        return;
      case "normal":
      default: {
        const stream = body?.stream === true;
        const tool = (body?.tools as unknown[] | undefined)?.length;
        if (stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(
            sse(tool ? ["Tok"] : ["Hello", " ", "world"], tool ? "tool_calls" : "stop")
          );
          return;
        }
        const msg: Record<string, unknown> = tool
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } },
              ],
            }
          : { role: "assistant", content: "Hello world" };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "cmpl-1",
            object: "chat.completion",
            model: body?.model,
            choices: [{ index: 0, message: msg, finish_reason: tool ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          })
        );
      }
    }
    return;
  }

  res.writeHead(404);
  res.end();
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((r) => server!.close(() => r()));
});

function makeGroq(): GroqAdapter {
  return new GroqAdapter(new ModelRegistry(), { baseUrl: `${base}/groq`, apiKey: "test-groq-key", timeoutMs: 5_000 });
}
function makeOpenRouter(): OpenRouterAdapter {
  return new OpenRouterAdapter(new ModelRegistry(), {
    baseUrl: `${base}/openrouter`,
    apiKey: "test-or-key",
    timeoutMs: 5_000,
  });
}

describe("openai-compat adapters (groq + openrouter) vs mock OpenAI server", () => {
  beforeAll(() => {
    mode = "normal";
    captured.length = 0;
  });

  it("groq: discovers models, maps context/tools/tier, namespaced ids", async () => {
    const a = makeGroq();
    const models = await a.listModels();
    expect(models.length).toBe(4);
    const llama = models.find((m) => m.id === "groq:llama-3.3-70b-versatile");
    expect(llama).toBeDefined();
    expect(llama!.context).toBe(131072);
    expect(llama!.tools).toBe(true);
    expect(llama!.tier).toBe("strong");
    expect(models.find((m) => m.id === "groq:gpt-oss-120b")!.tier).toBe("strong");
    expect(models.find((m) => m.id === "groq:llama-3.1-8b-instant")!.tier).toBe("mid");
    // whisper is not a chat model but discovery must not crash on it
    expect(a.listModelsSync()).toContain("groq:llama-3.3-70b-versatile");
  });

  it("openrouter: discovers models, pricing → cost mapping, :free detection, vision", async () => {
    const a = makeOpenRouter();
    const models: ProviderModelInfo[] = await a.listModels();
    expect(models.length).toBe(3);
    const free = models.find((m) => m.id === "openrouter:deepseek/deepseek-chat-v3.1:free")!;
    expect(free.inputCostCentsPerMTok).toBe(0);
    expect(free.tier).toBe("strong"); // deepseek family stays strong even when free
    const sol = models.find((m) => m.id === "openrouter:openai/gpt-5.6-sol")!;
    expect(sol.inputCostCentsPerMTok).toBe(150); // 0.0000015 USD/token → 150 ¢/MTok
    expect(sol.outputCostCentsPerMTok).toBe(600);
    expect(sol.tier).toBe("top");
    const vision = models.find((m) => m.id === "openrouter:google/gemini-2.5-flash-image")!;
    expect(vision.vision).toBe(true);
  });

  it("chat: wire request carries bearer auth, namespaced-id stripping, and OpenAI fields", async () => {
    captured.length = 0;
    const a = makeGroq();
    const r = await a.chat({
      model: "groq:llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      temperature: 0.3,
      max_tokens: 50,
      tool_choice: "auto",
      response_format: { type: "json_object" },
      seed: 7,
    });
    expect(r.message.content).toBe("Hello world");
    expect(r.finishReason).toBe("stop");
    expect(r.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    const req = captured.find((c) => c.body !== null)!;
    expect(req.path).toBe("/groq/chat/completions");
    expect(req.auth).toBe("Bearer test-groq-key");
    expect(req.body!.model).toBe("llama-3.3-70b-versatile"); // prefix stripped on the wire
    expect(req.body!.max_completion_tokens).toBe(50); // max_tokens → max_completion_tokens mapping
    expect(req.body!.temperature).toBe(0.3);
    expect(req.body!.tool_choice).toBe("auto");
    expect(req.body!.response_format).toEqual({ type: "json_object" });
    expect(req.body!.seed).toBe(7);
    expect(req.body!.stream).toBe(false);
  });

  it("chat: tool-call responses map into OpenAiMessage.tool_calls", async () => {
    const a = makeGroq();
    const r = await a.chat({
      model: "groq:llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "weather?" }],
      stream: false,
      tools: [
        { type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } },
      ],
    });
    expect(r.message.tool_calls?.[0]?.function.name).toBe("get_weather");
    expect(r.message.tool_calls?.[0]?.function.arguments).toBe('{"city":"Tokyo"}');
    expect(r.finishReason).toBe("tool_calls");
  });

  it("stream: yields content deltas, usage, and terminates at [DONE]", async () => {
    const a = makeOpenRouter();
    const iter = await a.stream({
      model: "openrouter:deepseek/deepseek-chat-v3.1:free",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const parts: string[] = [];
    let usage: { total_tokens: number } | null | undefined;
    for await (const ev of iter) {
      if (ev.delta.content) parts.push(ev.delta.content);
      if (ev.usage) usage = ev.usage;
    }
    expect(parts.join("")).toBe("Hello world");
    expect(usage?.total_tokens).toBe(18); // prompt 7 + completion 11
  });

  it("error matrix: 429 → rate_limit (retryable), Retry-After captured", async () => {
    mode = "rate-limit";
    const a = makeGroq();
    await expect(
      a.chat({ model: "groq:llama-3.3-70b-versatile", messages: [{ role: "user", content: "hi" }], stream: false })
    ).rejects.toMatchObject({ kind: "rate_limit", retryable: true, status: 429, retryAfterSec: null });
  });

  it("error matrix: Retry-After header surfaces in the classified error", async () => {
    mode = "retry-after";
    const a = makeGroq();
    await expect(
      a.chat({ model: "groq:llama-3.3-70b-versatile", messages: [{ role: "user", content: "hi" }], stream: false })
    ).rejects.toMatchObject({ retryAfterSec: 30 });
  });

  it("error matrix: 401 → auth (not retryable, switchProvider=false)", async () => {
    mode = "auth";
    const a = makeGroq();
    await expect(
      a.chat({ model: "groq:llama-3.3-70b-versatile", messages: [{ role: "user", content: "hi" }], stream: false })
    ).rejects.toMatchObject({ kind: "auth", retryable: false });
    // the failure lands in provider state as unhealthy — adapter still answers
    expect(await a.healthCheck()).toBe(false);
  });

  it("error matrix: 402 → quota_exhausted", async () => {
    mode = "quota";
    const a = makeOpenRouter();
    await expect(
      a.chat({ model: "openrouter:openai/gpt-5.6-sol", messages: [{ role: "user", content: "hi" }], stream: false })
    ).rejects.toMatchObject({ kind: "quota_exhausted" });
  });

  it("error matrix: context-length message → context_overflow", async () => {
    mode = "context-overflow";
    const a = makeOpenRouter();
    await expect(
      a.chat({ model: "openrouter:openai/gpt-5.6-sol", messages: [{ role: "user", content: "hi" }], stream: false })
    ).rejects.toMatchObject({ kind: "context_overflow" });
  });

  it("error matrix: 503 → server (retryable, switchProvider)", async () => {
    mode = "server-error";
    const a = makeGroq();
    await expect(
      a.chat({ model: "groq:llama-3.3-70b-versatile", messages: [{ role: "user", content: "hi" }], stream: false })
    ).rejects.toMatchObject({ kind: "server", retryable: true });
  });

  it("error matrix: 404 → unsupported_capability", async () => {
    mode = "not-found";
    const a = makeGroq();
    await expect(
      a.chat({ model: "groq:llama-3.3-70b-versatile", messages: [{ role: "user", content: "hi" }], stream: false })
    ).rejects.toMatchObject({ kind: "unsupported_capability" });
  });

  it("malformed upstream bodies are classified, not crashing", async () => {
    mode = "malformed-json";
    const a = makeGroq();
    await expect(
      a.chat({ model: "groq:llama-3.3-70b-versatile", messages: [{ role: "user", content: "hi" }], stream: false })
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("missing choices[0].message is malformed_response", async () => {
    mode = "missing-message";
    const a = makeGroq();
    await expect(
      a.chat({ model: "groq:llama-3.3-70b-versatile", messages: [{ role: "user", content: "hi" }], stream: false })
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("supports() honors ownership + capability contract", async () => {
    mode = "normal";
    const g = makeGroq();
    await g.listModels(); // load catalog before capability queries
    // unknown model: no capability metadata → treated as unrestricted when no
    // constraints are requested; conservative false when constraints are given
    expect(g.supports("groq:does-not-exist", {})).toBe(true);
    expect(g.supports("groq:does-not-exist", { tools: true })).toBe(false);
    expect(g.supports("groq:llama-3.3-70b-versatile", { tools: true })).toBe(true);
    expect(g.supports("groq:llama-3.3-70b-versatile", { minContext: 200_000 })).toBe(false);
    expect(g.contextLimit("groq:llama-3.3-70b-versatile")).toBe(131072);
  });

  it("discovery failure falls back to seed registry without throwing", async () => {
    const bad = new GroqAdapter(new ModelRegistry(), {
      baseUrl: "http://127.0.0.1:1/groq",
      apiKey: "k",
      timeoutMs: 500,
    });
    // must not throw even though /models is unreachable
    const models = await bad.listModels();
    expect(Array.isArray(models)).toBe(true);
    expect(await bad.healthCheck()).toBe(false);
    mode = "normal";
  });

  it("classifyError passes ClassifiedUpstreamError through unchanged", async () => {
    const a = makeGroq();
    mode = "normal";
    const c = a.classifyError(new ClassifiedUpstreamError("rate_limit", 429, "rate limited"));
    expect(c).toMatchObject({ kind: "rate_limit", retryable: true, switchProvider: true });
    const plain = a.classifyError(new TypeError("fetch failed"));
    expect(plain.kind).toBe("connection");
  });
});

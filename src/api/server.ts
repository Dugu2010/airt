import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig, parseMode } from "../core/config.js";
import { ModelRegistry } from "../registry/registry.js";
import { ProviderStateStore } from "../state/state.js";
import { PuterAdapter } from "../providers/puter.js";
import { PuterDirectAdapter } from "../providers/puter-direct.js";
import { GroqAdapter } from "../providers/groq.js";
import { OpenRouterAdapter } from "../providers/openrouter.js";
import { GoogleAiStudioAdapter } from "../providers/google-ai-studio.js";
import { CerebrasAdapter } from "../providers/cerebras.js";
import { MistralAdapter } from "../providers/mistral.js";
import { NvidiaAdapter } from "../providers/nvidia.js";
import { RoutingEngine } from "../routing/engine.js";
import { sanitize } from "./sanitize.js";
import type { AiSelectorConfig } from "../decision/ai-selector.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  RoutingMode,
  ProviderAdapter,
  ProviderModelInfo,
  AttemptTrace,
} from "../core/types.js";

const cfg = loadConfig();
const registry = new ModelRegistry();
const state = new ProviderStateStore();

const puter = new PuterAdapter(registry, {
  wrapperBase: cfg.puterWrapperBase,
  wrapperKey: cfg.puterWrapperKey,
  directToken: cfg.puterDirectToken,
  timeoutMs: cfg.timeoutMs,
});

const decisionCfg: AiSelectorConfig | null = cfg.rulesOnly
  ? null
  : {
      decisionAdapter: new PuterAdapter(registry, {
        wrapperBase: cfg.puterWrapperBase,
        wrapperKey: cfg.puterWrapperKey,
        directToken: cfg.puterDirectToken,
        timeoutMs: cfg.decisionTimeoutMs,
      }),
      model: cfg.decisionModel,
      fallbackModels: cfg.decisionFallbackModels,
      timeoutMs: cfg.decisionTimeoutMs,
    };

// ---- provider registration (only providers with usable credentials register) ----
interface ProviderEntry {
  adapter: ProviderAdapter;
  state: ProviderStateStore;
}
const providers: ProviderEntry[] = [];

// 1. Puter via the existing wrapper (primary).
providers.push({ adapter: new PuterAdapter(registry, {
  wrapperBase: cfg.puterWrapperBase,
  wrapperKey: cfg.puterWrapperKey,
  directToken: null, // wrapper outages fail over at engine level to puter-direct
  timeoutMs: cfg.timeoutMs,
}), state });

// 2. Puter direct driver — separate failure domain (different host/auth/payload).
//    Credential precedence: PUTER_DIRECT_TOKEN, then PUTER_API_KEY (same account).
if (cfg.puterDirectEnabled) {
  providers.push({
    adapter: new PuterDirectAdapter(registry, cfg.puterDirectToken ?? cfg.puterApiKey ?? "", cfg.timeoutMs),
    state: new ProviderStateStore(),
  });
}

// 3. OpenRouter (free :free models with plan rate limits) — requires OPENROUTER_API_KEY.
if (cfg.openrouterApiKey) {
  const orState = new ProviderStateStore();
  orState.setQuotaPolicy("openrouter", {
    provider: "openrouter",
    dailyTokenBudget: null,
    dailyRequestQuota: null, // 50 RPD fresh / 1000 RPD with $10 credits — account-dependent, unknown here
    source: "policy",
    confidence: "medium",
    note: "free :free models 20 RPM / 50 RPD (1000 RPD after $10 credits); verified 2026-09 openrouter.ai docs",
  });
  providers.push({ adapter: new OpenRouterAdapter(registry, { baseUrl: "https://openrouter.ai/api/v1", apiKey: cfg.openrouterApiKey, timeoutMs: cfg.timeoutMs, name: "openrouter" }), state: orState });
}

// 5. Google AI Studio (Gemini) — permanent free tier, per-project RPM/TPM/RPD (RPD resets midnight PT).
if (cfg.googleApiKey) {
  const gState = new ProviderStateStore();
  gState.setQuotaPolicy("google-ai-studio", {
    provider: "google-ai-studio",
    dailyTokenBudget: null,
    dailyRequestQuota: null, // per-model RPD shown in AI Studio; not a stable published number
    source: "policy",
    confidence: "medium",
    note: "permanent free tier confirmed (ai.google.dev rate-limits, 2026-09-26); per-model RPD ~10-20 for flash (estimate)",
  });
  providers.push({ adapter: new GoogleAiStudioAdapter(registry, { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: cfg.googleApiKey, timeoutMs: cfg.timeoutMs, name: "google-ai-studio" }), state: gState });
}

// 6. Groq — permanent free tier (30 RPM / 6k TPM / 1k RPD class, per model).
if (cfg.groqApiKey) {
  const grState = new ProviderStateStore();
  grState.setQuotaPolicy("groq", {
    provider: "groq",
    dailyTokenBudget: null,
    dailyRequestQuota: null, // per-model; ~1000 RPD class
    source: "policy",
    confidence: "medium",
    note: "free tier 30 RPM / 6k TPM / ~1k RPD class (console.groq.com/docs/rate-limits, 2026-09)",
  });
  providers.push({ adapter: new GroqAdapter(registry, { baseUrl: "https://api.groq.com/openai/v1", apiKey: cfg.groqApiKey, timeoutMs: cfg.timeoutMs, name: "groq" }), state: grState });
}

// 7. Cerebras — TRIAL CREDITS ONLY ($5 / 30 days, payment method required).
//    Official FAQ: no permanently free tier. Never advertised as free capacity.
if (cfg.cerebrasApiKey) {
  const cState = new ProviderStateStore();
  cState.setQuotaPolicy("cerebras", {
    provider: "cerebras",
    dailyTokenBudget: null,
    dailyRequestQuota: null,
    source: "policy",
    confidence: "high",
    note: "trial credits only ($5/30d, payment method required) — NOT permanent free (inference-docs.cerebras.ai, 2026-09-26)",
  });
  providers.push({ adapter: new CerebrasAdapter(registry, { baseUrl: "https://api.cerebras.ai/v1", apiKey: cfg.cerebrasApiKey, timeoutMs: cfg.timeoutMs, name: "cerebras" }), state: cState });
}

// 8. Mistral La Plateforme — free experimental plan (phone + opt-in required).
if (cfg.mistralApiKey) {
  const mState = new ProviderStateStore();
  mState.setQuotaPolicy("mistral", {
    provider: "mistral",
    dailyTokenBudget: null,
    dailyRequestQuota: null,
    source: "policy",
    confidence: "medium",
    note: "free experimental plan ~1 req/s, large monthly token allowance (docs.mistral.ai, 2026-09; medium confidence)",
  });
  providers.push({ adapter: new MistralAdapter(registry, { baseUrl: "https://api.mistral.ai/v1", apiKey: cfg.mistralApiKey, timeoutMs: cfg.timeoutMs, name: "mistral" }), state: mState });
}

// 9. NVIDIA NIM — credit-based hosted inference; NOT permanent free.
if (cfg.nvidiaApiKey) {
  const nState = new ProviderStateStore();
  nState.setQuotaPolicy("nvidia", {
    provider: "nvidia",
    dailyTokenBudget: null,
    dailyRequestQuota: null,
    source: "policy",
    confidence: "medium",
    note: "credit-based allocation; not a documented permanent free tier (build.nvidia.com, 2026-09)",
  });
  providers.push({ adapter: new NvidiaAdapter(registry, { baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: cfg.nvidiaApiKey, timeoutMs: cfg.timeoutMs, name: "nvidia" }), state: nState });
}

// Warm up every provider's model catalog so the scoring hot path
// (listModelsSync) sees each provider's models on the first request.
await Promise.all(providers.map((p) => p.adapter.listModels().catch(() => [])));

const engine = new RoutingEngine({
  providers: providers.map((p) => ({ adapter: p.adapter, state: p.state })),
  decision: decisionCfg,
  maxRetries: cfg.maxRetries,
  timeoutMs: cfg.timeoutMs,
  freeFirst: cfg.freeFirst,
  freeFallbackPolicy: cfg.freeFallbackPolicy,
});

// ---- client rate limiting (per-IP token bucket) -----------------------------
// ---- request-size guard: the existing 8 MB readBody cap below is the enforcement ----

// ---- client rate limiting (per-IP token bucket) -----------------------------
const buckets = new Map<string, { tokens: number; last: number }>();
function rateLimit(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: cfg.rateLimitPerMin, last: now };
  const refill = ((now - b.last) / 60_000) * cfg.rateLimitPerMin;
  b.tokens = Math.min(cfg.rateLimitPerMin, b.tokens + refill);
  b.last = now;
  if (b.tokens < 1) {
    buckets.set(ip, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(ip, b);
  return true;
}

function clientIp(req: IncomingMessage): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

function authorized(req: IncomingMessage): boolean {
  if (!cfg.routerApiKey) return true;
  const auth = req.headers.authorization ?? "";
  return auth === `Bearer ${cfg.routerApiKey}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function errorBody(message: string, type: string, code: string | null, status: number) {
  return { error: { message, type, code, param: null } };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  try {
    // ---- health / telemetry endpoints (no auth) ----
    if (req.method === "GET" && path === "/health") {
      const healthChecks = await Promise.all(
        providers.map(async (p) => ({ name: p.adapter.name, ok: await p.adapter.healthCheck() }))
      );
      const ok = healthChecks.some((h) => h.ok);
      return sendJson(res, ok ? 200 : 503, {
        status: ok ? "ok" : "degraded",
        providers: healthChecks,
        state: state.snapshot(),
      });
    }
    if (req.method === "GET" && path === "/v1/state") {
      return sendJson(res, 200, {
        providers: providers.map((p) => ({ name: p.adapter.name, models: p.adapter.listModelsSync().length })),
        health: state.snapshot(),
        registry: registry.all().length,
      });
    }

    // ---- models ----
    if (req.method === "GET" && path === "/v1/models") {
      if (!authorized(req)) return sendJson(res, 401, errorBody("Missing or invalid API key", "authentication_error", "invalid_api_key", 401));
      const seen = new Set<string>();
      const models: ProviderModelInfo[] = [];
      for (const p of providers) {
        for (const m of await p.adapter.listModels()) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            models.push(m);
          }
        }
      }
      return sendJson(res, 200, {
        object: "list",
        data: models.map((m) => ({
          id: m.id,
          object: "model",
          created: 1704067200,
          owned_by: m.id.split(":")[0] ?? "puter",
          context: m.context,
          tools: m.tools,
          vision: m.vision,
          tier: m.tier,
          input_cost_cents_per_mtok: m.inputCostCentsPerMTok,
        })),
      });
    }

    // ---- chat completions ----
    if (req.method === "POST" && path === "/v1/chat/completions") {
      if (!authorized(req)) {
        return sendJson(res, 401, errorBody("Missing or invalid API key", "authentication_error", "invalid_api_key", 401));
      }
      if (!rateLimit(clientIp(req))) {
        return sendJson(res, 429, errorBody("Rate limit exceeded", "rate_limit_error", "client_rate_limited", 429));
      }

      let body: ChatCompletionRequest & { routing_mode?: string };
      try {
        body = JSON.parse(await readBody(req)) as ChatCompletionRequest & { routing_mode?: string };
      } catch {
        return sendJson(res, 400, errorBody("Invalid JSON body", "invalid_request_error", "invalid_json", 400));
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return sendJson(res, 400, errorBody("'messages' array is required", "invalid_request_error", "missing_messages", 400));
      }

      // precedence: explicit routing_mode wins; otherwise full auto
      const mode: RoutingMode = parseMode(body.routing_mode ?? "auto");

      // "auto"/"router-auto" mean "you pick" — strip the field so the routing
      // engine (AI decisions included) runs instead of a pinned-model miss.
      const isAutoAlias = body.model === "router-auto" || body.model === "auto";
      const effective: ChatCompletionRequest = isAutoAlias ? { ...body, model: undefined } : body;

      if (effective.model) {
        // pinned model: honor it first, failover to best candidate
        const outcome = await routePinned(effective, mode);
        return streamOrJson(res, effective, outcome);
      }

      const outcome = await engine.route(effective, mode);
      return streamOrJson(res, effective, outcome);
    }

    return sendJson(res, 404, errorBody(`No route for ${req.method} ${path}`, "invalid_request_error", "not_found", 404));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /context/i.test(message) ? 400 : /exhausted|No alternative/i.test(message) ? 503 : 502;
    return sendJson(res, status, errorBody(sanitize(message), "api_error", "routing_failed", status));
  }
});

/** Pinned-model routing: try the requested model first, failover to best candidate. */
async function routePinned(req: ChatCompletionRequest, mode: RoutingMode) {
  const { scoreCandidates } = await import("../decision/decision.js");
  const { analyzeRequest } = await import("../analysis/analyzer.js");
  const analysis = analyzeRequest(req.messages);
  if (req.tools?.length) analysis.requiresTools = true;

  const ctx = {
    mode,
    analysis,
    messages: req.messages,
    tools: req.tools ?? [],
    availableProviders: providers.map((p) => ({ adapter: p.adapter, state: p.state })),
  };
  const { scored } = scoreCandidates(ctx);
  const pinned = scored.find((c) => c.model === req.model);
  const order = pinned ? [pinned, ...scored.filter((c) => c.model !== req.model)] : scored;

  if (order.length === 0) {
    throw new Error("No eligible candidates for pinned model routing");
  }

  // execute with the engine using a forced decision
  const engineAny = engine as unknown as {
    route: (req: ChatCompletionRequest, mode: RoutingMode) => Promise<unknown>;
  };
  void engineAny;
  // Simulate decision by calling engine.route with a custom decision — simplest correct
  // approach: call engine.route but with the pinned model injected as first candidate via
  // a temporary decision override is complex; instead inline a small loop here.
  const attempts: AttemptTrace[] = [];
  // exhaustive failover, same budget as the engine: sweep the whole ordered
  // candidate list (capped) instead of giving up after 3 tries.
  for (const cand of order.slice(0, 1 + RoutingEngine.MAX_FAILOVERS)) {
    const entry = providers.find((p) => p.adapter.name === cand.provider);
    if (!entry) continue;
    try {
      const started = Date.now();
      entry.state.recordStart(cand.provider, analysis.estimatedPromptTokens);
      const result = await entry.adapter.chat({
        model: cand.model,
        messages: req.messages,
        stream: false,
        temperature: req.temperature,
        top_p: req.top_p,
        max_tokens: req.max_tokens,
        stop: req.stop,
        tools: req.tools,
        tool_choice: req.tool_choice,
        response_format: req.response_format,
        seed: req.seed,
      });
      entry.state.recordSuccess(cand.provider, Date.now() - started, result.ttftMs ?? null, result.usage);
      const { makeId, nowEpoch } = await import("../util/ids.js");
      const completion: ChatCompletionResponse = {
        id: makeId("chatcmpl"),
        object: "chat.completion",
          created: nowEpoch(),
          model: cand.model,
          choices: [
            {
              index: 0,
              message: result.message,
              logprobs: null,
              finish_reason: result.message.tool_calls?.length ? "tool_calls" : result.finishReason === "end_turn" ? "stop" : result.finishReason,
            },
          ],
        usage: result.usage ?? { prompt_tokens: analysis.estimatedPromptTokens, completion_tokens: 0, total_tokens: analysis.estimatedPromptTokens },
        router: {
          mode,
          analysis,
          decision: {
            provider: cand.provider,
            model: cand.model,
            score: cand.score,
            reason: pinned ? "pinned model requested by client" : "pinned model unavailable — best candidate",
            decisionSource: pinned ? ("rules" as const) : ("fallback-chain" as const),
            candidates: order.slice(0, 8),
            rejected: [],
            decisionLatencyMs: 0,
          },
          attempts,
          totalLatencyMs: Date.now() - started,
          fallbackCount: pinned ? 0 : 1,
          retryCount: 0,
        },
      };
      return { response: completion, trace: { mode, analysis, decision: completion.router!, attempts, totalLatencyMs: completion.router!.totalLatencyMs, fallbackCount: completion.router!.fallbackCount, retryCount: 0 } };
    } catch (err) {
      const classified = (providers.find((p) => p.adapter.name === cand.provider) ?? providers[0]!).adapter.classifyError(err);
      attempts.push({
        provider: cand.provider,
        model: cand.model,
        attempt: attempts.length + 1,
        startedAt: Date.now(),
        durationMs: 0,
        ttftMs: null,
        ok: false,
        error: classified,
      });
      entry.state.recordFailure(cand.provider, classified.kind, classified.message, classified.retryAfterSec ?? null);
    }
  }
  const last = attempts[attempts.length - 1]?.error;
  throw new Error(
    `Routing exhausted after ${attempts.length} attempt(s)` +
      (last ? `. Last error (${last.kind}): ${last.message.slice(0, 200)}` : "")
  );
}

/** Stream or JSON response dispatch. */
async function streamOrJson(
  res: ServerResponse,
  body: ChatCompletionRequest & { routing_mode?: string },
  outcome: { response: ChatCompletionResponse }
): Promise<void> {
  const wantsStream = body.stream === true;
  if (!wantsStream) {
    return sendJson(res, 200, outcome.response);
  }

  // Execution produced the full completion; re-emit as SSE chunks in OpenAI format.
  const r = outcome.response;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({
    id: r.id,
    object: "chat.completion.chunk",
    created: r.created,
    model: r.model,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });
  const content = r.choices[0]?.message?.content ?? "";
  const chunkSize = 64;
  for (let i = 0; i < content.length; i += chunkSize) {
    send({
      id: r.id,
      object: "chat.completion.chunk",
      created: r.created,
      model: r.model,
      choices: [{ index: 0, delta: { content: content.slice(i, i + chunkSize) }, finish_reason: null }],
    });
  }
  for (const tc of r.choices[0]?.message?.tool_calls ?? []) {
    send({
      id: r.id,
      object: "chat.completion.chunk",
      created: r.created,
      model: r.model,
      choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }],
    });
  }
  send({
    id: r.id,
    object: "chat.completion.chunk",
    created: r.created,
    model: r.model,
    choices: [{ index: 0, delta: {}, finish_reason: r.choices[0]?.finish_reason ?? "stop" }],
  });
  send({
    id: r.id,
    object: "chat.completion.chunk",
    created: r.created,
    model: r.model,
    choices: [],
    usage: r.usage,
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      data += c.toString("utf8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

server.listen(cfg.port, "0.0.0.0", () => {
  const addr = server.address();
  const shown = addr && typeof addr === "object" ? addr.port : cfg.port;
  console.log(`[router] listening on :${shown} (decision=${cfg.rulesOnly ? "rules-only" : cfg.decisionModel})`);
});

export { server, cfg, engine, registry, state, puter };

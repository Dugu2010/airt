import {
  type ProviderAdapter,
  type ProviderModelInfo,
  type ProviderChatResult,
  type ChatRequestForProvider,
  type QuotaState,
  type Usage,
  type OpenAiMessage,
  type ChatMessage,
} from "../core/types.js";
import { ModelRegistry } from "../registry/registry.js";
import { ClassifiedUpstreamError, classifyHttpError, isMalformedResponse } from "../errors/classify.js";
import { estimateTokens } from "../analysis/tokens.js";

interface PuterConfig {
  wrapperBase: string;
  wrapperKey: string | null;
  directToken: string | null;
  timeoutMs: number;
}

interface WireChatResponse {
  choices?: Array<{ message?: Record<string, unknown>; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Provider adapter for Puter via the EXISTING wrapper endpoint
 * (OpenAI-compatible POST /v1/chat/completions at PUTER_WRAPPER_BASE).
 *
 * The wrapper is the Puter integration; this adapter owns only the HTTP client,
 * catalog refresh, health classification, and streaming translation.
 *
 * Last-resort fallback: if the wrapper is unreachable (connection/server errors)
 * and PUTER_DIRECT_TOKEN is configured, calls go straight to Puter's
 * user-pays driver endpoint (api.puter.com/drivers/call) with the same payload
 * shape the wrapper translates. This keeps routing alive during wrapper outages.
 */
export class PuterAdapter implements ProviderAdapter {
  readonly name = "puter";
  private registry: ModelRegistry;
  private cfg: PuterConfig;
  private catalogLoaded = false;

  constructor(registry: ModelRegistry, cfg: PuterConfig) {
    this.registry = registry;
    this.cfg = cfg;
  }

  // ---- discovery -----------------------------------------------------------

  /** Ownership guard: models namespaced to the direct adapter are not ours. */
  private ownsModel(id: string): boolean {
    return !id.startsWith("puter-direct:");
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    await this.ensureCatalog();
    return this.registry.all().filter((m) => this.ownsModel(m.id));
  }

  private async ensureCatalog(): Promise<void> {
    if (this.catalogLoaded) return;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch("https://api.puter.com/puterai/chat/models/details", {
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
      const json = (await res.json()) as { models?: PuterCatalogEntry[] };
      const entries = (json.models ?? [])
        .map((m) => catalogEntryToRegistry(m))
        .filter((e): e is NonNullable<typeof e> => e !== null);
      this.registry.refresh(entries);
      this.catalogLoaded = true;
    } catch {
      // catalog is an enhancement; seed registry still works
      this.catalogLoaded = true;
    }
  }

  capabilities(model: string): ProviderModelInfo | null {
    return this.ownsModel(model) ? this.registry.get(model) : null;
  }

  contextLimit(model: string): number {
    return this.registry.get(model)?.context ?? 128_000;
  }

  supports(model: string, req: { tools?: boolean; vision?: boolean; minContext?: number }): boolean {
    const cap = this.registry.get(model);
    if (!cap) return req.minContext == null;
    if (req.tools && !cap.tools) return false;
    if (req.vision && !cap.vision) return false;
    if (req.minContext != null && cap.context < req.minContext) return false;
    return true;
  }

  listModelsSync(): string[] {
    return this.registry
      .all()
      .filter((m) => this.ownsModel(m.id))
      .map((m) => m.id);
  }

  // ---- health / quota --------------------------------------------------------

  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      // The wrapper's landing page is a cheap liveness probe.
      const res = await fetch(`${this.cfg.wrapperBase}/`, { signal: controller.signal, cache: "no-store" });
      clearTimeout(timer);
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }

  quota(): QuotaState {
    // Puter user-pays: the upstream enforces allowance; we expose optimistic
    // defaults and rely on classifyError(429) to mark exhaustion.
    return {
      rpm: 0,
      tpm: 0,
      rpd: 0,
      dailyTokenBudget: null,
      tokensUsedToday: 0,
      exhausted: false,
      source: "reactive",
      confidence: "low",
      resetsAt: null,
      remainingTokens: null,
      lastObservation: null,
      dailyRequestsQuota: null,
      requestsToday: 0,
      dailyResetKey: "",
    };
  }

  usage(): Usage | null {
    return null;
  }

  // ---- execution --------------------------------------------------------------

  async chat(req: ChatRequestForProvider, signal?: AbortSignal): Promise<ProviderChatResult> {
    const attempt = async (): Promise<ProviderChatResult> => {
      const body = {
        model: req.model,
        messages: req.messages,
        stream: false,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
        ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
        ...(req.stop !== undefined ? { stop: req.stop } : {}),
        ...(req.tools !== undefined ? { tools: req.tools } : {}),
        ...(req.tool_choice !== undefined ? { tool_choice: req.tool_choice } : {}),
        ...(req.response_format !== undefined ? { response_format: req.response_format } : {}),
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
      };

      const started = Date.now();
      const res = await this.wrappedFetch("/v1/chat/completions", body, signal);
      if (!res.ok) {
        const text = await res.text();
        throw classifyHttpError(res.status, text, res.headers);
      }
      let json: WireChatResponse;
      try {
        json = (await res.json()) as WireChatResponse;
      } catch {
        throw isMalformedResponse("Upstream returned non-JSON body");
      }
      const choice = json.choices?.[0];
      if (!choice || typeof choice.message !== "object" || choice.message === null) {
        throw isMalformedResponse("Upstream response missing choices[0].message");
      }
      const msg = choice.message as Record<string, unknown>;
      const content = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p) => (typeof p === "object" && p && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("") : "";
      const out: OpenAiMessage = { role: "assistant", content: content || null };
      if (Array.isArray(msg.tool_calls)) out.tool_calls = msg.tool_calls as OpenAiMessage["tool_calls"];
      if (typeof msg.reasoning === "string") out.reasoning = msg.reasoning;

      const usage: Usage | null = json.usage
        ? {
            prompt_tokens: json.usage.prompt_tokens ?? 0,
            completion_tokens: json.usage.completion_tokens ?? 0,
            total_tokens: (json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0),
          }
        : null;

      return {
        message: out,
        finishReason: choice.finish_reason ?? "stop",
        usage,
        ttftMs: Date.now() - started,
      };
    };

    try {
      return await attempt();
    } catch (err) {
      // Wrapper down? Try direct driver path once, if a token is configured.
      if (this.cfg.directToken && isWrapperOutage(err)) {
        return this.directChat(req, signal);
      }
      throw err;
    }
  }

  async stream(req: ChatRequestForProvider): Promise<AsyncIterable<{ delta: Partial<OpenAiMessage>; usage?: Usage | null }>> {
    const self = this;
    const body = {
      model: req.model,
      messages: req.messages,
      stream: true,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
      ...(req.tools !== undefined ? { tools: req.tools } : {}),
      ...(req.tool_choice !== undefined ? { tool_choice: req.tool_choice } : {}),
    };

    const res = await this.wrappedFetch("/v1/chat/completions", body);
    if (!res.ok) {
      const text = await res.text();
      throw classifyHttpError(res.status, text, res.headers);
    }
    if (!res.body) throw isMalformedResponse("Empty stream body");

    async function* iterate(): AsyncIterable<{ delta: Partial<OpenAiMessage>; usage?: Usage | null }> {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") return;
          try {
            const evt = JSON.parse(payload) as {
              choices?: Array<{ delta?: Record<string, unknown> }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
            };
            const delta = evt.choices?.[0]?.delta ?? {};
            const out: Partial<OpenAiMessage> = {};
            if (typeof delta.content === "string") out.content = delta.content;
            if (Array.isArray(delta.tool_calls)) out.tool_calls = delta.tool_calls as OpenAiMessage["tool_calls"];
            if (typeof delta.reasoning === "string") out.reasoning = delta.reasoning;
            if (typeof delta.role === "string") out.role = "assistant";
            const usage =
              evt.usage && (evt.usage.prompt_tokens != null || evt.usage.completion_tokens != null)
                ? {
                    prompt_tokens: evt.usage.prompt_tokens ?? 0,
                    completion_tokens: evt.usage.completion_tokens ?? 0,
                    total_tokens: (evt.usage.prompt_tokens ?? 0) + (evt.usage.completion_tokens ?? 0),
                  }
                : null;
            if (Object.keys(out).length > 0 || usage) yield { delta: out, usage };
          } catch {
            // skip malformed SSE line
          }
        }
      }
    }
    void self;
    return iterate();
  }

  classifyError(err: unknown) {
    if (err instanceof ClassifiedUpstreamError) return err.toClassified();
    return classifyHttpError(0, err instanceof Error ? err.message : String(err));
  }

  // ---- internals ------------------------------------------------------------

  private async wrappedFetch(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      return await fetch(`${this.cfg.wrapperBase}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.cfg.wrapperKey ? { Authorization: `Bearer ${this.cfg.wrapperKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Direct fallback through Puter's user-pays driver (payload re-shaped). */
  private async directChat(req: ChatRequestForProvider, signal?: AbortSignal): Promise<ProviderChatResult> {
    const args: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => stripMessage(m)),
      stream: false,
    };
    if (req.temperature !== undefined) args.temperature = req.temperature;
    if (req.max_tokens !== undefined) args.max_tokens = req.max_tokens;
    if (req.tools !== undefined) args.tools = req.tools;
    if (req.tool_choice !== undefined) args.tool_choice = req.tool_choice;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const res = await fetch("https://api.puter.com/drivers/call", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.directToken}`,
        },
        body: JSON.stringify({ interface: "puter-chat-completion", method: "complete", args }),
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        throw classifyHttpError(res.status, text, res.headers);
      }
      const json = (await res.json()) as {
        result?: { message?: Record<string, unknown>; finish_reason?: unknown; usage?: Record<string, unknown> };
      };
      const msg = json.result?.message ?? {};
      const out: OpenAiMessage = { role: "assistant", content: typeof msg.content === "string" ? msg.content : null };
      if (Array.isArray(msg.tool_calls)) out.tool_calls = msg.tool_calls as OpenAiMessage["tool_calls"];
      if (typeof msg.reasoning === "string") out.reasoning = msg.reasoning;
      const u = json.result?.usage ?? {};
      return {
        message: out,
        finishReason: typeof json.result?.finish_reason === "string" ? json.result.finish_reason : "stop",
        usage: {
          prompt_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
          completion_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
          total_tokens:
            (typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0) +
            (typeof u.completion_tokens === "number" ? u.completion_tokens : 0),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isWrapperOutage(err: unknown): boolean {
  const c = err instanceof ClassifiedUpstreamError ? err : null;
  if (!c) {
    const msg = err instanceof Error ? err.message : String(err);
    const causeCode = (err as { cause?: { code?: string } })?.cause?.code ?? "";
    return (
      err instanceof TypeError ||
      (err instanceof DOMException && err.name === "AbortError") ||
      /unable to connect|fetch failed|socket hang up|econn/i.test(msg) ||
      /ECONNREFUSED|ECONNRESET|ENOTFOUND/i.test(causeCode)
    );
  }
  return c.kind === "connection" || c.kind === "timeout" || (c.kind === "server" && (c.status ?? 0) >= 500);
}

function stripMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls !== undefined) out.tool_calls = m.tool_calls;
  if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
  if (m.name !== undefined) out.name = m.name;
  return out;
}

export { estimateTokens };

/** One row of https://api.puter.com/puterai/chat/models/details. */
export interface PuterCatalogEntry {
  puterId?: string;
  id?: string;
  input_cost_key?: string;
  output_cost_key?: string;
  context?: number;
  max_tokens?: number;
  tool_call?: boolean;
  modalities?: { input?: string[] };
  costs?: Record<string, unknown>;
}

/**
 * Convert a live catalog row into a registry refresh entry.
 * Cost key names differ per upstream (prompt_tokens/completion_tokens vs
 * prompt/completion vs input/output) — each row declares its own via
 * input_cost_key/output_cost_key. Rows whose prompt AND completion cost are
 * 0 cents are sponsor-priced (Puter's free tier, ~31 models as of 2026-09-26)
 * and get free: true; fair-use rate limits still apply (reactive 429 path).
 */
export function catalogEntryToRegistry(
  entry: PuterCatalogEntry,
  idPrefix = ""
): (Partial<ProviderModelInfo> & { id: string }) | null {
  const rawId = entry.puterId ?? (typeof entry.id === "string" && entry.id.includes(":") ? entry.id : undefined);
  if (!rawId) return null;
  const costs = entry.costs ?? {};
  const inKey = entry.input_cost_key ?? "prompt_tokens";
  const outKey = entry.output_cost_key ?? "completion_tokens";
  const inCost = typeof costs[inKey] === "number" ? (costs[inKey] as number) : undefined;
  const outCost = typeof costs[outKey] === "number" ? (costs[outKey] as number) : undefined;
  const sponsorPriced = inCost === 0 && outCost === 0;
  return {
    id: `${idPrefix}${rawId}`,
    context: entry.context ?? undefined,
    maxOutput: entry.max_tokens ?? undefined,
    tools: entry.tool_call ?? undefined,
    vision: entry.modalities?.input?.includes("image") ?? undefined,
    audio: entry.modalities?.input?.includes("audio") ?? undefined,
    inputCostCentsPerMTok: inCost,
    outputCostCentsPerMTok: outCost,
    free: sponsorPriced ? true : undefined,
    // Seed-pinned ids keep their curated tier (undefined tier = no override);
    // new sponsor-priced ids get a family hint instead of cost-based "light".
    tier: sponsorPriced ? sponsorTier(rawId) : undefined,
  };
}

function sponsorTier(id: string): ProviderModelInfo["tier"] {
  const m = id.toLowerCase();
  if (/ultra|550b|235b|kimi-k2|nemotron-3-super|v4-(pro|flash)|qwen3\.8-27b|inkling(?!-small)/.test(m)) return "strong";
  if (/flash|mini|nano|lite|-2\.6b|bonsai|30b|preview/.test(m)) return "light";
  return "mid";
}

import {
  type ProviderAdapter,
  type ProviderModelInfo,
  type ProviderChatResult,
  type ChatRequestForProvider,
  type QuotaState,
  type Usage,
  type OpenAiMessage,
  type ClassifiedError,
} from "../core/types.js";
import { ModelRegistry } from "../registry/registry.js";
import {
  ClassifiedUpstreamError,
  classifyHttpError,
  isMalformedResponse,
  classifyUpstreamError,
} from "../errors/classify.js";

export interface OpenAiCompatConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  /** Provider name used in traces/state ("groq", "openrouter", ...). */
  name: string;
}

/**
 * Shared adapter for OpenAI-compatible /chat/completions + /models APIs
 * (Groq, OpenRouter, and similar providers). Subclasses supply the model
 * seed/discovery specifics; the wire protocol is identical.
 */
export abstract class OpenAiCompatAdapter implements ProviderAdapter {
  abstract readonly name: string;
  protected registry: ModelRegistry;
  protected cfg: OpenAiCompatConfig;

  constructor(registry: ModelRegistry, cfg: OpenAiCompatConfig) {
    this.registry = registry;
    this.cfg = cfg;
  }

  // ---- discovery -----------------------------------------------------------

  async listModels(): Promise<ProviderModelInfo[]> {
    await this.ensureCatalog();
    return this.registry.all().filter((m) => this.ownsModel(m.id));
  }

  private async ensureCatalog(): Promise<void> {
    if (this.catalogLoaded) return;
    try {
      const res = await this.fetchJson("GET", "/models", undefined, 15_000);
      const rows = (res?.data ?? []) as Array<Record<string, unknown>>;
      const entries = rows.map((m) => this.toModelInfo(m)).filter((m): m is ProviderModelInfo => m !== null);
      if (entries.length > 0) {
        this.registry.refresh(entries);
        this.catalogLoaded = true;
        return;
      }
    } catch {
      // discovery failed — fall back to seed registry
    }
    this.catalogLoaded = true;
  }

  /** Convert a /models row into registry info. Null = not offered by this provider. */
  protected abstract toModelInfo(row: Record<string, unknown>): ProviderModelInfo | null;

  /** Does this adapter own the given registry model id? */
  protected abstract ownsModel(id: string): boolean;

  listModelsSync(): string[] {
    return this.registry
      .all()
      .filter((m) => this.ownsModel(m.id))
      .map((m) => m.id);
  }

  capabilities(model: string): ProviderModelInfo | null {
    return this.ownsModel(model) ? this.registry.get(model) : null;
  }

  contextLimit(model: string): number {
    return this.registry.get(model)?.context ?? 8_000;
  }

  supports(model: string, req: { tools?: boolean; vision?: boolean; minContext?: number }): boolean {
    const cap = this.capabilities(model);
    // Unknown model: only claim support when NO constraints are requested —
    // never silently claim tool/vision/context capability we cannot verify.
    if (!cap) return req.minContext == null && !req.tools && !req.vision;
    if (req.tools && !cap.tools) return false;
    if (req.vision && !cap.vision) return false;
    if (req.minContext != null && cap.context < req.minContext) return false;
    return true;
  }

  // ---- health / quota --------------------------------------------------------

  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.fetchRaw("GET", "/models", undefined, 5_000);
      return res.ok;
    } catch {
      return false;
    }
  }

  quota(): QuotaState {
    // These providers expose no quota query API; the upstream enforces
    // documented plan limits and our state store reacts to 429/402.
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
    const body: Record<string, unknown> = {
      model: this.wireModel(req.model),
      messages: req.messages,
      stream: false,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.max_tokens !== undefined) body.max_completion_tokens = req.max_tokens;
    if (req.stop !== undefined) body.stop = req.stop;
    if (req.tools !== undefined) body.tools = req.tools;
    if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
    if (req.response_format !== undefined) body.response_format = req.response_format;
    if (req.seed !== undefined) body.seed = req.seed;

    const started = Date.now();
    const res = await this.fetchJson("POST", "/chat/completions", body, this.cfg.timeoutMs, signal);
    const choice = (res as { choices?: Array<{ message?: Record<string, unknown>; finish_reason?: unknown }> })?.choices?.[0];
    const msg = choice?.message;
    if (!msg || typeof msg !== "object") {
      throw isMalformedResponse("Upstream response missing choices[0].message");
    }
    const out: OpenAiMessage = { role: "assistant", content: typeof msg.content === "string" ? msg.content : null };
    if (Array.isArray(msg.tool_calls)) out.tool_calls = msg.tool_calls as OpenAiMessage["tool_calls"];
    if (typeof msg.reasoning === "string") out.reasoning = msg.reasoning;

    const u = ((res as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage ?? {}) as {
      prompt_tokens?: number;
      completion_tokens?: number;
    };
    const usage: Usage | null =
      typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number"
        ? {
            prompt_tokens: u.prompt_tokens ?? 0,
            completion_tokens: u.completion_tokens ?? 0,
            total_tokens: (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
          }
        : null;

    return {
      message: out,
      finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "stop",
      usage,
      ttftMs: Date.now() - started,
    };
  }

  async stream(
    req: ChatRequestForProvider
  ): Promise<AsyncIterable<{ delta: Partial<OpenAiMessage>; usage?: Usage | null }>> {
    const body: Record<string, unknown> = {
      model: this.wireModel(req.model),
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.max_tokens !== undefined) body.max_completion_tokens = req.max_tokens;
    if (req.tools !== undefined) body.tools = req.tools;
    if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;

    const res = await this.fetchRaw("POST", "/chat/completions", body, this.cfg.timeoutMs);
    if (!res.ok) {
      const text = await res.text();
      throw classifyHttpError(res.status, text, res.headers);
    }
    if (!res.body) throw isMalformedResponse("Empty stream body");

    // Idle-read watchdog: after headers, a stream that stalls in total silence
    // must surface an error instead of hanging forever. Slow-but-alive streams
    // are unaffected — only SILENCE longer than the timeout is fatal.
    const idleMs = Math.max(this.cfg.timeoutMs, 1_000);

    async function* iterate(reader: ReadableStreamDefaultReader<Uint8Array>) {
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const idle = new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error(`stream idle for ${idleMs}ms`)), idleMs);
          // unref so a pending watchdog never holds the process open
          (t as unknown as { unref?: () => void }).unref?.();
        });
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          const result = await Promise.race([reader.read(), idle]);
          done = result.done;
          value = result.value;
        } catch (e) {
          reader.cancel().catch(() => {});
          throw e;
        }
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
    return iterate(res.body.getReader());
  }

  classifyError(err: unknown): ClassifiedError {
    if (err instanceof ClassifiedUpstreamError) return err.toClassified();
    return classifyUpstreamError(err);
  }

  // ---- provider-specific hooks -------------------------------------------------

  /** Model id as sent on the wire (strip any router-side prefixing). */
  protected wireModel(id: string): string {
    return id;
  }

  protected get catalogLoadedFlag(): boolean {
    return this.catalogLoaded;
  }
  private catalogLoaded = false;

  // ---- HTTP ----------------------------------------------------------------------

  protected async fetchRaw(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      return await fetch(`${this.cfg.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        body: method === "POST" ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        cache: "no-store",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  protected async fetchJson<T = Record<string, unknown>>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    const res = await this.fetchRaw(method, path, body, timeoutMs, signal);
    if (!res.ok) {
      const text = await res.text();
      throw classifyHttpError(res.status, text, res.headers);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw isMalformedResponse("Upstream returned non-JSON body");
    }
  }
}

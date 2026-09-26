import {
  type ProviderAdapter,
  type ProviderModelInfo,
  type ProviderChatResult,
  type ChatRequestForProvider,
  type QuotaState,
  type Usage,
  type OpenAiMessage,
  type ChatMessage,
  type ClassifiedError,
} from "../core/types.js";
import { ModelRegistry } from "../registry/registry.js";
import {
  ClassifiedUpstreamError,
  classifyHttpError,
  isMalformedResponse,
  classifyUpstreamError,
} from "../errors/classify.js";

/**
 * Puter Direct adapter — talks straight to Puter's user-pays driver endpoint
 * (POST https://api.puter.com/drivers/call, interface "puter-chat-completion").
 *
 * This is a genuinely separate failure domain from the wrapper-based Puter
 * adapter: different hostname, different auth path, different payload shape.
 * If the wrapper host is down or its deployment breaks, direct still routes.
 *
 * Verified live (2026-09-26, free Puter account):
 * - POST /drivers/call {interface,method:"complete",args} → 200
 *   {success, result:{message:{role,content,...}, finish_reason, usage:{prompt_tokens,completion_tokens,cached_tokens,usd_cents}}}
 * - args.stream=true → newline-delimited JSON events:
 *   {"type":"text","text":"..."} ... {"type":"usage","usage":{...}}
 * - official /puterai/openai/v1 endpoint → 402 subscription_required on free accounts
 *
 * Requires PUTER_DIRECT_TOKEN (a Puter API token). Without it not registered.
 */
export class PuterDirectAdapter implements ProviderAdapter {
  readonly name = "puter-direct";
  private registry: ModelRegistry;
  private token: string;
  private timeoutMs: number;
  private catalogLoaded = false;

  constructor(registry: ModelRegistry, token: string, timeoutMs: number) {
    this.registry = registry;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  private static ENDPOINT = "https://api.puter.com/drivers/call";

  // ---- discovery -----------------------------------------------------------

  async listModels(): Promise<ProviderModelInfo[]> {
    await this.ensureCatalog();
    return this.registry.all().filter((m) => this.ownsModel(m.id));
  }

  private async ensureCatalog(): Promise<void> {
    if (this.catalogLoaded) return;
    // Same live Puter catalog as the wrapper exposes; details endpoint needs no auth.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch("https://api.puter.com/puterai/chat/models/details", {
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = (await res.json()) as {
          models?: Array<{
            puterId?: string;
            context?: number;
            max_tokens?: number;
            tool_call?: boolean;
            modalities?: { input?: string[] };
            costs?: { prompt_tokens?: number; completion_tokens?: number };
          }>;
        };
        const entries = (json.models ?? [])
          .filter((m) => typeof m.puterId === "string")
          .map((m) => ({
            id: `puter-direct:${m.puterId as string}`,
            context: m.context ?? undefined,
            maxOutput: m.max_tokens ?? undefined,
            tools: m.tool_call ?? undefined,
            vision: m.modalities?.input?.includes("image") ?? undefined,
            audio: m.modalities?.input?.includes("audio") ?? undefined,
            inputCostCentsPerMTok: m.costs?.prompt_tokens ?? undefined,
            outputCostCentsPerMTok: m.costs?.completion_tokens ?? undefined,
            // Sponsor-priced models publish 0 cents/MTok -> genuinely $0 to the account.
            free: (m.costs?.prompt_tokens === 0 && m.costs?.completion_tokens === 0) || undefined,
          }));
        if (entries.length > 0) this.registry.refresh(entries);
      }
    } catch {
      // catalog is an enhancement; seed registry still works
    }
    this.catalogLoaded = true;
  }

  private ownsModel(id: string): boolean {
    return id.startsWith("puter-direct:");
  }

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
    return this.registry.get(model)?.context ?? 128_000;
  }

  supports(model: string, req: { tools?: boolean; vision?: boolean; minContext?: number }): boolean {
    const cap = this.capabilities(model);
    if (!cap) return req.minContext == null;
    if (req.tools && !cap.tools) return false;
    if (req.vision && !cap.vision) return false;
    if (req.minContext != null && cap.context < req.minContext) return false;
    return true;
  }

  // ---- health / quota --------------------------------------------------------

  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch("https://api.puter.com/", { signal: controller.signal, cache: "no-store" });
      clearTimeout(timer);
      return res.status < 500 || res.status === 404;
    } catch {
      return false;
    }
  }

  quota(): QuotaState {
    // User-pays driver: upstream enforces the account allowance; we react to 429/402.
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

  // ---- execution ----------------------------------------------------------------

  async chat(req: ChatRequestForProvider, signal?: AbortSignal): Promise<ProviderChatResult> {
    const args: Record<string, unknown> = {
      model: this.wireModel(req.model),
      messages: req.messages.map(stripMessage),
      stream: false,
    };
    if (req.temperature !== undefined) args.temperature = req.temperature;
    if (req.top_p !== undefined) args.top_p = req.top_p;
    if (req.max_tokens !== undefined) args.max_tokens = req.max_tokens;
    if (req.stop !== undefined) args.stop = req.stop;
    if (req.tools !== undefined) args.tools = req.tools;
    if (req.tool_choice !== undefined) args.tool_choice = req.tool_choice;

    const started = Date.now();
    const json = await this.driverCall(args, signal);
    const result = (json.result ?? {}) as Record<string, unknown>;
    const msg = (result.message ?? {}) as Record<string, unknown>;
    const out: OpenAiMessage = {
      role: "assistant",
      content: typeof msg.content === "string" ? msg.content : null,
    };
    if (Array.isArray(msg.tool_calls)) out.tool_calls = msg.tool_calls as OpenAiMessage["tool_calls"];
    if (typeof msg.reasoning === "string") out.reasoning = msg.reasoning;

    const u = (result.usage ?? {}) as Record<string, unknown>;
    const usage: Usage = {
      prompt_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
      completion_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
      total_tokens:
        (typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0) +
        (typeof u.completion_tokens === "number" ? u.completion_tokens : 0),
    };

    return {
      message: out,
      finishReason: typeof result.finish_reason === "string" ? result.finish_reason : "stop",
      usage,
      ttftMs: Date.now() - started,
    };
  }

  async stream(
    req: ChatRequestForProvider
  ): Promise<AsyncIterable<{ delta: Partial<OpenAiMessage>; usage?: Usage | null }>> {
    const args: Record<string, unknown> = {
      model: this.wireModel(req.model),
      messages: req.messages.map(stripMessage),
      stream: true,
    };
    if (req.temperature !== undefined) args.temperature = req.temperature;
    if (req.max_tokens !== undefined) args.max_tokens = req.max_tokens;
    if (req.tools !== undefined) args.tools = req.tools;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(PuterDirectAdapter.ENDPOINT, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ interface: "puter-chat-completion", method: "complete", args }),
        signal: controller.signal,
        cache: "no-store",
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text();
      throw classifyHttpError(res.status, text, res.headers);
    }
    if (!res.body) throw isMalformedResponse("Empty stream body");

    // Idle-read watchdog (same rationale as the OpenAI-compat adapter).
    const idleMs = Math.max(this.timeoutMs, 1_000);

    async function* iterate(reader: ReadableStreamDefaultReader<Uint8Array>) {
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const idle = new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error(`stream idle for ${idleMs}ms`)), idleMs);
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
          if (!trimmed) continue;
          try {
            const evt = JSON.parse(trimmed) as {
              type?: string;
              text?: string;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            if (evt.type === "text" && typeof evt.text === "string") {
              yield { delta: { content: evt.text } as Partial<OpenAiMessage>, usage: null };
            } else if (evt.type === "usage" && evt.usage) {
              const usage = {
                prompt_tokens: evt.usage.prompt_tokens ?? 0,
                completion_tokens: evt.usage.completion_tokens ?? 0,
                total_tokens: (evt.usage.prompt_tokens ?? 0) + (evt.usage.completion_tokens ?? 0),
              };
              yield { delta: {} as Partial<OpenAiMessage>, usage };
            }
          } catch {
            // skip malformed line
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

  // ---- internals ------------------------------------------------------------------

  protected wireModel(id: string): string {
    return id.startsWith("puter-direct:") ? id.slice("puter-direct:".length) : id;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
    };
  }

  private async driverCall(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const res = await fetch(PuterDirectAdapter.ENDPOINT, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ interface: "puter-chat-completion", method: "complete", args }),
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        throw classifyHttpError(res.status, text, res.headers);
      }
      try {
        const json = (await res.json()) as Record<string, unknown>;
        if (json.success !== true) {
          throw new ClassifiedUpstreamError("malformed_response", res.status, "Driver response missing success:true");
        }
        return json;
      } catch (e) {
        if (e instanceof ClassifiedUpstreamError) throw e;
        throw isMalformedResponse("Driver returned non-JSON body");
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function stripMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls !== undefined) out.tool_calls = m.tool_calls;
  if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
  if (m.name !== undefined) out.name = m.name;
  return out;
}

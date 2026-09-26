import type {
  ProviderAdapter,
  ProviderModelInfo,
  ProviderChatResult,
  ChatRequestForProvider,
  QuotaState,
  Usage,
  OpenAiMessage,
  ClassifiedError,
} from "../../src/core/types.js";
import { ClassifiedUpstreamError } from "../../src/errors/classify.js";

/**
 * Configurable provider stub for multi-provider integration tests.
 * Deliberately a test double (not a production adapter): lets us script
 * precise failure sequences (timeout, 429, 5xx, outage, quota, malformed,
 * context overflow) to verify cross-provider failover deterministically.
 */
export type ScriptedFailure =
  | "timeout"
  | "connection"
  | "rate_limit"
  | "server"
  | "quota"
  | "malformed"
  | "context_overflow"
  | "auth"
  | "unsupported";

export interface StubModelSpec {
  id: string;
  tier: ProviderModelInfo["tier"];
  context?: number;
  tools?: boolean;
  vision?: boolean;
  inputCostCentsPerMTok?: number | null;
  free?: boolean;
}

export interface StubScript {
  /** Fail the first N chat calls with this kind, then succeed. */
  failFirstN?: number;
  failKind?: ScriptedFailure;
  /** Fail ALL chat calls with this kind (permanent outage). */
  failAll?: ScriptedFailure;
  /** Simulated latency per chat call (ms). */
  latencyMs?: number;
  /** Reply text on success. */
  reply?: string;
  /** Per-call reply sequence (index = call number - 1); falls back to `reply`. */
  replySequence?: string[];
  /** Per-call finish reasons (index = call number - 1); defaults to "stop". */
  finishSequence?: string[];
}

const FAILURE_ERROR: Record<ScriptedFailure, () => Error> = {
  timeout: () => {
    const e = new DOMException("The operation was aborted", "AbortError");
    return e;
  },
  connection: () => new TypeError("fetch failed: connection refused"),
  rate_limit: () => new ClassifiedUpstreamError("rate_limit", 429, "Rate limit exceeded (stub)"),
  server: () => new ClassifiedUpstreamError("server", 500, "Internal server error (stub)"),
  quota: () => new ClassifiedUpstreamError("quota_exhausted", 402, "quota exceeded for this billing period (stub)"),
  malformed: () => new ClassifiedUpstreamError("malformed_response", null, "Upstream response missing choices[0].message (stub)"),
  context_overflow: () =>
    new ClassifiedUpstreamError("context_overflow", 400, "This model's maximum context length is 8192 tokens (stub)"),
  auth: () => new ClassifiedUpstreamError("auth", 401, "Invalid API key (stub)"),
  unsupported: () => new ClassifiedUpstreamError("unsupported_capability", 404, "model not found (stub)"),
};

export class StubAdapter implements ProviderAdapter {
  readonly name: string;
  private models: StubModelSpec[];
  private script: StubScript;
  private calls = 0;

  constructor(name: string, models: StubModelSpec[], script: StubScript = {}) {
    this.name = name;
    this.models = models;
    this.script = script;
  }

  get callCount(): number {
    return this.calls;
  }

  setScript(script: StubScript): void {
    this.script = script;
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    return this.models.map(toInfo);
  }

  listModelsSync(): string[] {
    return this.models.map((m) => m.id);
  }

  capabilities(model: string): ProviderModelInfo | null {
    const m = this.models.find((x) => x.id === model);
    return m ? toInfo(m) : null;
  }

  contextLimit(model: string): number {
    return this.capabilities(model)?.context ?? 8_000;
  }

  async healthCheck(): Promise<boolean> {
    return this.script.failAll !== "connection" && this.script.failAll !== "timeout";
  }

  quota(): QuotaState {
    return { rpm: 0, tpm: 0, rpd: 0, dailyTokenBudget: null, tokensUsedToday: 0, exhausted: this.script.failAll === "quota" };
  }

  usage(): Usage | null {
    return null;
  }

  supports(model: string, req: { tools?: boolean; vision?: boolean; minContext?: number }): boolean {
    const cap = this.capabilities(model);
    if (!cap) return req.minContext == null && !req.tools && !req.vision;
    if (req.tools && !cap.tools) return false;
    if (req.vision && !cap.vision) return false;
    if (req.minContext != null && cap.context < req.minContext) return false;
    return true;
  }

  async chat(req: ChatRequestForProvider, signal?: AbortSignal): Promise<ProviderChatResult> {
    void signal;
    this.calls += 1;
    const n = this.calls;

    if (this.script.failAll) throw FAILURE_ERROR[this.script.failAll]();
    if (this.script.failFirstN && n <= this.script.failFirstN && this.script.failKind) {
      throw FAILURE_ERROR[this.script.failKind]();
    }
    if (this.script.latencyMs) await new Promise((r) => setTimeout(r, this.script.latencyMs));

    const content = this.script.replySequence?.[n - 1] ?? this.script.reply ?? `${this.name} reply to: ${req.messages.at(-1) ?? ""}`;
    const message: OpenAiMessage = { role: "assistant", content };
    return {
      message,
      finishReason: this.script.finishSequence?.[n - 1] ?? "stop",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      ttftMs: 12,
    };
  }

  async stream(
    req: ChatRequestForProvider
  ): Promise<AsyncIterable<{ delta: Partial<OpenAiMessage>; usage?: Usage | null }>> {
    void req;
    this.calls += 1;
    async function* gen(self: StubAdapter) {
      if (self.script.failAll) throw FAILURE_ERROR[self.script.failAll]();
      if (self.script.failFirstN && self.calls <= self.script.failFirstN && self.script.failKind) {
        throw FAILURE_ERROR[self.script.failKind]();
      }
      yield { delta: { content: `${self.name} ` } as Partial<OpenAiMessage>, usage: null };
      yield { delta: { content: "stream" } as Partial<OpenAiMessage>, usage: null };
      yield {
        delta: {} as Partial<OpenAiMessage>,
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    }
    return gen(this);
  }

  classifyError(err: unknown): ClassifiedError {
    if (err instanceof ClassifiedUpstreamError) return err.toClassified();
    if (err instanceof DOMException && err.name === "AbortError") {
      return { kind: "timeout", status: null, message: "timed out", retryable: true, switchProvider: true };
    }
    if (err instanceof TypeError) {
      return { kind: "connection", status: null, message: err.message, retryable: true, switchProvider: true };
    }
    return { kind: "unknown", status: null, message: String(err), retryable: false, switchProvider: true };
  }
}

function toInfo(m: StubModelSpec): ProviderModelInfo {
  return {
    id: m.id,
    context: m.context ?? 128_000,
    maxOutput: 32_768,
    tools: m.tools ?? false,
    vision: m.vision ?? false,
    audio: false,
    inputCostCentsPerMTok: m.inputCostCentsPerMTok ?? 50,
    outputCostCentsPerMTok: m.inputCostCentsPerMTok ?? 50,
    tier: m.tier,
    free: m.free,
  };
}

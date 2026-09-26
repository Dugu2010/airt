/** ---- Chat wire types (OpenAI-compatible subset) ---- */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  tools?: Tool[];
  tool_choice?: unknown;
  response_format?: unknown;
  seed?: number;
  user?: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface Choice {
  index: number;
  message: OpenAiMessage;
  logprobs: null;
  finish_reason: string;
}

export interface OpenAiMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
  reasoning?: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Choice[];
  usage: Usage;
  /** Router metadata (OpenAI clients ignore unknown fields). */
  router?: RoutingTrace;
}

/** ---- Task analysis ---- */

export type TaskType =
  | "chat"
  | "reasoning"
  | "coding"
  | "long_context"
  | "summarization"
  | "extraction"
  | "tool_use"
  | "multimodal"
  | "creative";

export interface TaskAnalysis {
  primary: TaskType;
  secondary: TaskType[];
  difficulty: 1 | 2 | 3 | 4 | 5; // 1 trivial … 5 hardest
  requiresTools: boolean;
  requiresVision: boolean;
  requiresLongContext: boolean;
  requiresReasoning: boolean;
  estimatedPromptTokens: number;
  signals: string[]; // human-readable evidence for the trace
}

/** ---- Routing ---- */

export type RoutingMode = "auto" | "fast" | "quality" | "reasoning" | "free" | "balanced";

export interface RoutingDecision {
  provider: string;
  model: string; // provider-specific model id
  score: number;
  reason: string;
  decisionSource: "ai" | "rules" | "fallback-chain" | "context-fallback";
  candidates: ScoredCandidate[];
  rejected: Array<{ model: string; reason: string }>;
  decisionLatencyMs: number;
  /** Raw order proposed by the AI decision model (null = AI not used/unavailable). */
  aiOrder?: string[] | null;
}

export interface ScoredCandidate {
  provider: string;
  model: string;
  score: number;
  reasons: string[];
  /** Member of the free-first decision pool: permanently-free tier, or (in
   * explicit FREE mode) cheap-class capacity with very low/unknown cost. */
  free?: boolean;
  /** 0..1 quota headroom estimate for the candidate's provider (null = unknown). */
  quotaRemaining?: number | null;
}

/** ---- Provider contracts ---- */

export interface ProviderModelInfo {
  id: string;
  context: number;
  maxOutput: number;
  tools: boolean;
  vision: boolean;
  audio: boolean;
  inputCostCentsPerMTok: number | null; // null = unknown/unmetered
  outputCostCentsPerMTok: number | null;
  tier: "top" | "strong" | "mid" | "light";
  /** True when the model is served on a provider's permanently-free tier:
   * groq, google-ai-studio, mistral, openrouter `:free`, and Puter's
   * sponsor-priced catalog entries (0/0 US cents per MTok). Absent/false =
   * paid/credit-metered (metered puter models, cerebras, nvidia, paid openrouter). */
  free?: boolean;
}

export interface HealthState {
  healthy: boolean;
  open: boolean; // circuit breaker open
  lastError: string | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  cooldownUntil: number | null;
  latencyEmaMs: number | null;
  ttftEmaMs: number | null;
  successRate: number | null; // 0..1 over recent window
  rateLimitedUntil: number | null;
}

export interface QuotaState {
  rpm: number; // requests per minute, current estimate
  tpm: number; // tokens per minute estimate
  rpd: number; // requests today estimate
  dailyTokenBudget: number | null; // null = unknown
  tokensUsedToday: number;
  exhausted: boolean;
  // ---- free-capacity intelligence (phase 3) ----
  /** Where this quota knowledge came from. */
  source: "policy" | "estimated" | "reactive";
  /** How trustworthy the quota numbers are. */
  confidence: "high" | "medium" | "low";
  /** Epoch ms when the daily window resets (null = unknown). */
  resetsAt: number | null;
  /** Estimated remaining tokens today (null = unknown). */
  remainingTokens: number | null;
  /** Last quota observation (non-sensitive note + timestamp). */
  lastObservation: { at: number; source: string; note: string } | null;
  /** Known daily request cap (null = unknown). */
  dailyRequestsQuota: number | null;
  requestsToday: number;
  /** UTC day key the counters belong to. */
  dailyResetKey: string;
}

export type UpstreamErrorKind =
  | "rate_limit"
  | "auth"
  | "quota_exhausted"
  | "context_overflow"
  | "unsupported_capability"
  | "malformed_response"
  | "timeout"
  | "connection"
  | "server"
  | "unknown";

export interface ClassifiedError {
  kind: UpstreamErrorKind;
  status: number | null;
  message: string;
  retryable: boolean;
  switchProvider: boolean;
  /** Retry-After seconds from the upstream, when supplied. */
  retryAfterSec?: number | null;
}

/** ---- Trace / observability ---- */

export interface AttemptTrace {
  provider: string;
  model: string;
  attempt: number;
  startedAt: number;
  durationMs: number | null;
  ttftMs: number | null;
  ok: boolean;
  error?: ClassifiedError;
}

export interface RoutingTrace {
  /** Unique request id for correlation (safe to expose). */
  requestId?: string;
  mode: RoutingMode;
  analysis: TaskAnalysis;
  decision: RoutingDecision;
  attempts: AttemptTrace[];
  totalLatencyMs: number;
  fallbackCount: number;
  retryCount: number;
  /** "success" after validation, or the error kind that exhausted routing. */
  finalStatus?: "success" | string;
  /** Distinct providers that failed at least once during this request. */
  providersFailed?: string[];
}

/** ---- Provider adapter interface ---- */

export interface ChatRequestForProvider {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  tools?: Tool[];
  tool_choice?: unknown;
  response_format?: unknown;
  seed?: number;
}

export interface ProviderChatResult {
  message: OpenAiMessage;
  finishReason: string;
  usage: Usage | null;
  ttftMs?: number;
}

export interface ProviderAdapter {
  readonly name: string;
  listModels(): Promise<ProviderModelInfo[]>;
  capabilities(model: string): ProviderModelInfo | null;
  contextLimit(model: string): number;
  healthCheck(): Promise<boolean>;
  quota(): QuotaState;
  supports(model: string, req: { tools?: boolean; vision?: boolean; minContext?: number }): boolean;
  /** Synchronous registry view for the scoring hot path. */
  listModelsSync(): string[];
  chat(req: ChatRequestForProvider, signal?: AbortSignal): Promise<ProviderChatResult>;
  stream(req: ChatRequestForProvider): Promise<AsyncIterable<{ delta: Partial<OpenAiMessage>; usage?: Usage | null }>>;
  classifyError(err: unknown): ClassifiedError;
}

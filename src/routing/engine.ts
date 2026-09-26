import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ProviderAdapter,
  RoutingMode,
  RoutingTrace,
  AttemptTrace,
  TaskAnalysis,
} from "../core/types.js";
import type { ProviderStateStore } from "../state/state.js";
import { decideRouting, scoreCandidates, type DecisionContext } from "../decision/decision.js";
import { aiSelectModels, type AiSelectorConfig } from "../decision/ai-selector.js";
import { analyzeRequest } from "../analysis/analyzer.js";
import { ClassifiedUpstreamError } from "../errors/classify.js";
import { estimateTokens } from "../analysis/tokens.js";
import { makeId, nowEpoch } from "../util/ids.js";

export interface EngineDeps {
  providers: Array<{ adapter: ProviderAdapter; state: ProviderStateStore }>;
  decision: AiSelectorConfig | null; // null = rules-only
  maxRetries: number;
  timeoutMs: number;
  /** FREE-mode policy when no capable free/cheap candidate exists. */
  freeFallbackPolicy?: "reject" | "allow-paid";
}

export interface RouteOutcome {
  response: ChatCompletionResponse;
  trace: RoutingTrace;
}

const CONTEXT_RETRY_SHRINK = 0.6; // when upstream says context overflow, retry with trimmed history

export class RoutingEngine {
  constructor(private deps: EngineDeps) {}

  async route(req: ChatCompletionRequest, mode: RoutingMode): Promise<RouteOutcome> {
    const started = Date.now();
    const attempts: AttemptTrace[] = [];
    const providersFailed = new Set<string>();
    let retryCount = 0;
    let fallbackCount = 0;

    // ---- 1. analyze ----------------------------------------------------------
    const analysis = analyzeWithTools(req);

    // ---- 2. decide -----------------------------------------------------------
    const ctx: DecisionContext = {
      mode,
      analysis,
      messages: req.messages,
      tools: req.tools ?? [],
      availableProviders: this.deps.providers,
    };

    let decision = await this.decide(ctx);
    const decisionSource = decision.decisionSource;

    if (decision.provider === "none" || decision.model === "none") {
      // Nothing eligible — surface the reason (FREE-mode reject policy, quota,
      // capability mismatch) instead of attempting an execution that cannot run.
      throw new ClassifiedUpstreamError("unsupported_capability", 503, decision.reason);
    }

    // ---- 3. execute → validate → classify → retry/switch ----------------------
    let messages = req.messages;
    let lastError: { kind: string; message: string } | null = null;

    for (let attempt = 1; attempt <= this.deps.maxRetries + 1; attempt++) {
      const provider = this.deps.providers.find((p) => p.adapter.name === decision.provider);
      const adapter = provider?.adapter;
      const state = provider?.state;

      if (!adapter || !state) {
        lastError = { kind: "routing", message: "selected provider missing" };
        break;
      }

      const cap = adapter.capabilities(decision.model);
      const estTokens = estimateTokens(messages);
      if (cap && estTokens > cap.context) {
        // huge prompt vs selected model: shrink context deterministically
        const shrunk = shrinkMessages(messages, cap.context);
        if (shrunk.length < messages.length) {
          messages = shrunk;
          analysis.signals.push(`context shrunk to ${messages.length} messages for ${decision.model}`);
        }
      }

      const trace0: AttemptTrace = {
        provider: adapter.name,
        model: decision.model,
        attempt,
        startedAt: Date.now(),
        durationMs: null,
        ttftMs: null,
        ok: false,
      };

      state.recordStart(adapter.name, estTokens);

      try {
        const result = await adapter.chat(
          {
            model: decision.model,
            messages,
            stream: false,
            temperature: req.temperature,
            top_p: req.top_p,
            max_tokens: req.max_tokens,
            stop: req.stop,
            tools: req.tools,
            tool_choice: req.tool_choice,
            response_format: req.response_format,
            seed: req.seed,
          },
          undefined
        );

        // ---- validate ----
        if (!result.message || (result.message.content == null && !result.message.tool_calls?.length)) {
          throw new ClassifiedUpstreamError("malformed_response", null, "empty message content and no tool_calls");
        }

        trace0.ok = true;
        trace0.durationMs = Date.now() - trace0.startedAt;
        trace0.ttftMs = result.ttftMs ?? trace0.durationMs;
        attempts.push(trace0);
        state.recordSuccess(adapter.name, trace0.durationMs, trace0.ttftMs, result.usage);

        const total = Date.now() - started;
        const requestId = makeId("rreq");
        return {
          response: {
            id: makeId("chatcmpl"),
            object: "chat.completion",
            created: nowEpoch(),
            model: decision.model,
            choices: [
              {
                index: 0,
                message: result.message,
                logprobs: null,
                finish_reason: normalizeFinish(result.finishReason, result.message.tool_calls?.length),
              },
            ],
            usage: result.usage ?? { prompt_tokens: estTokens, completion_tokens: 0, total_tokens: estTokens },
            router: {
              requestId,
              mode,
              analysis,
              decision,
              attempts,
              totalLatencyMs: total,
              fallbackCount,
              retryCount,
              finalStatus: "success",
              providersFailed: [...providersFailed],
            },
          },
          trace: {
            requestId,
            mode,
            analysis,
            decision,
            attempts,
            totalLatencyMs: total,
            fallbackCount,
            retryCount,
            finalStatus: "success",
            providersFailed: [...providersFailed],
          },
        };
      } catch (err) {
        const classified = adapter.classifyError(err);
        trace0.ok = false;
        trace0.durationMs = Date.now() - trace0.startedAt;
        trace0.error = classified;
        attempts.push(trace0);
        state.recordFailure(adapter.name, classified.kind, classified.message, classified.retryAfterSec ?? null);
        providersFailed.add(adapter.name);
        lastError = { kind: classified.kind, message: classified.message };

        if (attempt > this.deps.maxRetries) break;

        if (classified.kind === "context_overflow") {
          // trim and retry same model
          const capCtx = adapter.contextLimit(decision.model);
          const shrunk = shrinkMessages(messages, Math.floor(capCtx * CONTEXT_RETRY_SHRINK));
          if (shrunk.length >= messages.length) {
            // cannot shrink further → switch model
            fallbackCount++;
            decision = await this.nextCandidate(ctx, decision.model, lastError, decision.provider);
            continue;
          }
          messages = shrunk;
          retryCount++;
          continue;
        }

        if (classified.switchProvider) {
          // try same model once on retryable errors, then switch
          if (classified.retryable && attempt <= this.deps.maxRetries - 1 && attempt === 1) {
            retryCount++;
            await backoff(attempt);
            continue;
          }
          fallbackCount++;
          decision = await this.nextCandidate(ctx, decision.model, lastError, decision.provider);
          continue;
        }

        // non-retryable (e.g. auth, bad request) → try next candidate once
        fallbackCount++;
        decision = await this.nextCandidate(ctx, decision.model, lastError, decision.provider);
      }
    }

    throw new ClassifiedUpstreamError(
      "server",
      502,
      `Routing exhausted after ${attempts.length} attempt(s). Last error (${lastError?.kind}): ${lastError?.message}`
    );
  }

  private async decide(ctx: DecisionContext) {
    const phaseStarted = Date.now();
    const { scored } = scoreCandidates(ctx);
    let aiResult: string[] | null = null;
    // FREE mode: cost is the binding constraint and decideRouting ignores the
    // AI order there anyway — skip the wasted decision-model round-trip.
    if (this.deps.decision && ctx.mode !== "free" && scored.length > 1) {
      aiResult = await aiSelectModels(this.deps.decision, {
        ctx,
        candidates: scored.slice(0, 8).map((c) => ({ model: c.model, score: c.score })),
        taskText: flatten(ctx.messages),
      });
    }
    const decision = await decideRouting(
      ctx,
      { rulesOnly: !this.deps.decision, freeFallbackPolicy: this.deps.freeFallbackPolicy ?? "reject" },
      aiResult
    );
    // decision latency covers the WHOLE decide phase (AI call + scoring), so
    // traces reflect the real cost of decision-making.
    decision.decisionLatencyMs = Date.now() - phaseStarted;
    return decision;
  }

  /** Error kinds that implicate the PROVIDER (host/auth/account) rather than one
   * model — failover must then prefer a different provider outright. */
  private static PROVIDER_LEVEL_KINDS = new Set(["timeout", "connection", "server", "rate_limit", "quota_exhausted"]);

  /** Pick the next-best candidate, excluding tried models. In-flight failover
   * ignores the circuit breaker (which gates NEW requests, not the current one)
   * but still respects quota exhaustion. After a provider-level failure
   * (timeout/connection/5xx/429/quota) the next candidate is taken from a
   * DIFFERENT provider when one exists — capability compatibility is already
   * guaranteed by the hard filters in scoreCandidates. Throws the original
   * classified error when no alternatives remain (better client diagnostics). */
  private nextCandidate(
    ctx: DecisionContext,
    excludeModel: string,
    lastError?: { kind: string; message: string },
    failedProvider?: string
  ) {
    const { scored } = scoreCandidates(ctx, { ignoreCircuit: true });
    const rest = scored.filter((c) => c.model !== excludeModel);
    const providerLevel = lastError != null && RoutingEngine.PROVIDER_LEVEL_KINDS.has(lastError.kind);
    const next =
      (providerLevel && failedProvider ? rest.find((c) => c.provider !== failedProvider) : undefined) ?? rest[0];
    if (!next) {
      const detail = lastError ? ` (${lastError.kind}: ${lastError.message.slice(0, 200)})` : "";
      throw new ClassifiedUpstreamError("server", 503, `No alternative candidates available for failover${detail}`);
    }
    return {
      provider: next.provider,
      model: next.model,
      score: next.score,
      reason: `failover from ${excludeModel}${providerLevel && next.provider !== failedProvider ? ` (provider ${failedProvider} failed)` : ""}`,
      decisionSource: "fallback-chain" as const,
      candidates: scored.slice(0, 8),
      rejected: [],
      decisionLatencyMs: 0,
    };
  }
}

function firstPickProvider(ctx: DecisionContext): string {
  const { scored } = scoreCandidates(ctx);
  return scored[0]?.provider ?? "none";
}

function analyzeWithTools(req: ChatCompletionRequest): TaskAnalysis {
  const analysis = analyzeRequest(req.messages);
  if (req.tools && req.tools.length > 0) {
    analysis.requiresTools = true;
    analysis.signals.push(`${req.tools.length} tool(s) provided`);
  }
  return analysis;
}

/**
 * Deterministic context shrink. Always preserves: system messages, the first
 * user message, and the FINAL message (the current question). Middle history
 * is dropped oldest-first until the estimate fits.
 */
export function shrinkMessages(messages: ChatMessage[], contextLimit: number): ChatMessage[] {
  const perMsgTokens = (m: ChatMessage) => estimateTokens([m]);
  let total = messages.reduce((acc, m) => acc + perMsgTokens(m), 0);
  if (total <= contextLimit * 0.9) return messages;

  const head = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const firstUser = rest.find((m) => m.role === "user");
  const finalMsg = messages[messages.length - 1];

  const kept: ChatMessage[] = [...head];
  if (firstUser && firstUser !== finalMsg) kept.push(firstUser);

  // walk from newest to oldest, keeping what fits; final message always kept
  const tail: ChatMessage[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i]!;
    if (m === firstUser) continue;
    const isFinal = m === finalMsg;
    const t = perMsgTokens(m);
    if (!isFinal && total - t > contextLimit * 0.9) {
      total -= t;
      continue;
    }
    tail.unshift(m);
  }
  return [...kept, ...tail];
}

function backoff(attempt: number): Promise<void> {
  const base = 500 * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * base * 0.3);
  return new Promise((r) => setTimeout(r, Math.min(base + jitter, 8_000)));
}

function normalizeFinish(reason: string, hasTools?: number): string {
  if (hasTools) return "tool_calls";
  if (reason === "end_turn") return "stop";
  if (reason === "max_tokens" || reason === "length") return "length";
  if (reason === "tool_use") return "tool_calls";
  return reason || "stop";
}

function flatten(messages: ChatMessage[]): string {
  return messages
    .slice(-4)
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 1200) : "[structured]"}`)
    .join("\n");
}

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ProviderAdapter,
  RoutingDecision,
  RoutingMode,
  RoutingTrace,
  AttemptTrace,
  TaskAnalysis,
} from "../core/types.js";
import type { ProviderStateStore } from "../state/state.js";
import { decideRouting, scoreCandidates, selectPool, type DecisionContext } from "../decision/decision.js";
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
  /** FREE-mode policy when no capable free-tier candidate exists. */
  freeFallbackPolicy?: "reject" | "allow-paid";
  /** Free-first routing (default true): always prefer free-tier models with
   * remaining quota; paid models (puter) serve only when free capacity is out. */
  freeFirst?: boolean;
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
    // Failover budget: the loop keeps switching candidates until EVERY capable
    // model has been tried (capped by MAX_FAILOVERS switches), so a provider
    // dying mid-chain never starves the remaining providers. Same-model
    // retries are what maxRetries governs.
    let messages = req.messages;
    let lastError: { kind: string; message: string } | null = null;
    const triedModels = new Set<string>();
    const providerFailCounts = new Map<string, number>();
    let sameModelTries = 0; // retries of the CURRENT model (governed by maxRetries)
    const totalCap = this.deps.maxRetries + 1 + RoutingEngine.MAX_FAILOVERS;

    for (let attempt = 1; attempt <= totalCap; attempt++) {
      const provider = this.deps.providers.find((p) => p.adapter.name === decision.provider);
      const adapter = provider?.adapter;
      const state = provider?.state;

      if (!adapter || !state) {
        lastError = { kind: "routing", message: "selected provider missing" };
        break;
      }
      triedModels.add(decision.model);

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
        providerFailCounts.set(adapter.name, (providerFailCounts.get(adapter.name) ?? 0) + 1);
        lastError = { kind: classified.kind, message: classified.message };

        if (classified.kind === "context_overflow") {
          // trim and retry same model
          const capCtx = adapter.contextLimit(decision.model);
          const shrunk = shrinkMessages(messages, Math.floor(capCtx * CONTEXT_RETRY_SHRINK));
          if (shrunk.length >= messages.length || sameModelTries >= this.deps.maxRetries) {
            // cannot shrink further (or retry budget for this model spent) → switch
            fallbackCount++;
            const next = this.nextCandidate(ctx, triedModels, lastError, decision.provider, providerFailCounts);
            if (!next) break;
            decision = next;
            sameModelTries = 0;
            continue;
          }
          messages = shrunk;
          retryCount++;
          sameModelTries++;
          continue;
        }

        if (classified.switchProvider) {
          // try same model once on retryable errors, then switch
          if (classified.retryable && fallbackCount === 0 && sameModelTries === 0 && this.deps.maxRetries >= 2) {
            retryCount++;
            sameModelTries++;
            await backoff(attempt);
            continue;
          }
          fallbackCount++;
          const next = this.nextCandidate(ctx, triedModels, lastError, decision.provider, providerFailCounts);
          if (!next) break;
          decision = next;
          sameModelTries = 0;
          continue;
        }

        // non-retryable (e.g. auth, bad request) → try next candidate
        fallbackCount++;
        const next = this.nextCandidate(ctx, triedModels, lastError, decision.provider, providerFailCounts);
        if (!next) break;
        decision = next;
        sameModelTries = 0;
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
    // Free-first policy: free-tier candidates with remaining quota always form
    // the decision pool when any exist; paid (puter) takes over only when they
    // don't. FREE mode is strict per the configured fallback policy.
    const pool = selectPool(scored, ctx.mode, {
      freeFirst: this.deps.freeFirst ?? true,
      freeFallbackPolicy: this.deps.freeFallbackPolicy ?? "reject",
    });
    const base = pool ? pool.entries : scored;
    let aiResult: string[] | null = null;
    if (this.deps.decision && base.length > 1 && ctx.mode !== "free") {
      aiResult = await aiSelectModels(this.deps.decision, {
        ctx,
        candidates: base
          .slice(0, 8)
          .map((c) => ({ model: c.model, score: c.score, free: c.free, quotaRemaining: c.quotaRemaining })),
        taskText: flatten(ctx.messages),
      });
    }
    const decision = await decideRouting(
      ctx,
      { rulesOnly: !this.deps.decision, freeFallbackPolicy: this.deps.freeFallbackPolicy ?? "reject" },
      aiResult,
      pool
    );
    // decision latency covers the WHOLE decide phase (AI call + scoring), so
    // traces reflect the real cost of decision-making.
    decision.decisionLatencyMs = Date.now() - phaseStarted;
    return decision;
  }

  /** Error kinds that implicate the PROVIDER (host/auth/account) rather than one
   * model — failover must then prefer a different provider outright. */
  private static PROVIDER_LEVEL_KINDS = new Set(["timeout", "connection", "server", "rate_limit", "quota_exhausted"]);

  /** Hard cap on candidate SWITCHES per request (on top of maxRetries
   * same-model retries). High enough to sweep every provider realistically in
   * the pool, low enough that a total outage still terminates. */
  static MAX_FAILOVERS = 12;

  /** Pick the next-best candidate, excluding every model already TRIED in this
   * request (no ping-pong). In-flight failover ignores the circuit breaker
   * (which gates NEW requests, not the current one) but still respects quota
   * exhaustion. Free-first: remaining free-tier candidates are preferred
   * before any paid model; strict FREE mode returns null when its free pool
   * runs out instead of spending money. After a provider-level failure
   * (timeout/connection/5xx/429/quota) the next candidate is taken from a
   * DIFFERENT provider when one exists, and providers that already failed 2+
   * times in this request are skipped unless nothing else remains — one dead
   * provider can never consume the whole failover budget. Returns null when
   * no alternative candidates remain. */
  private nextCandidate(
    ctx: DecisionContext,
    triedModels: Set<string>,
    lastError?: { kind: string; message: string },
    failedProvider?: string,
    providerFailCounts?: Map<string, number>
  ): RoutingDecision | null {
    const { scored } = scoreCandidates(ctx, { ignoreCircuit: true });
    const rest = scored.filter((c) => !triedModels.has(c.model));
    const freeRest = rest.filter((c) => c.free === true);
    let candidates = rest;
    if (freeRest.length > 0 && ((this.deps.freeFirst ?? true) || ctx.mode === "free")) {
      candidates = freeRest;
    } else if (ctx.mode === "free") {
      // strict free mode: never spend money on failover; route() surfaces the
      // exhaustion error with the last real failure attached.
      return null;
    }
    if (candidates.length === 0) return null;
    const fails = (name: string) => providerFailCounts?.get(name) ?? 0;
    const providerLevel = lastError != null && RoutingEngine.PROVIDER_LEVEL_KINDS.has(lastError.kind);
    const fresh = candidates.filter((c) => fails(c.provider) < 2);
    const pool = fresh.length > 0 ? fresh : candidates;
    const next =
      (providerLevel && failedProvider ? pool.find((c) => c.provider !== failedProvider) : undefined) ?? pool[0];
    if (!next) return null;
    return {
      provider: next.provider,
      model: next.model,
      score: next.score,
      reason: `failover from ${[...triedModels].slice(-1)[0] ?? "?"}${providerLevel && next.provider !== failedProvider ? ` (provider ${failedProvider} failed)` : ""}`,
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

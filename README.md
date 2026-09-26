# Autonomous AI Inference Router

A production-hardened, multi-provider routing layer for AI inference. The router receives an
OpenAI-style chat request, analyzes the task, checks live provider health, quota and
capability, dynamically selects the strongest suitable model across ALL registered
providers, executes it, validates the response, and retries / switches providers / fails
over on failure.

It is **not** a static model selector: candidate ordering comes from live state (health,
latency EMA, circuit breakers with half-open recovery, per-minute token windows, daily
quota intelligence with Retry-After) combined with deterministic per-mode scoring,
optionally re-ranked by an internal AI decision model that can never bypass the
deterministic hard filters.

This project is fully isolated: its own source, package config, dependencies, tests, docs,
and env contract. It communicates with the Puter wrapper (a separately deployed service)
purely over HTTP and holds no dependency on any other project in the workspace.

**Docs:** [ARCHITECTURE.md](./ARCHITECTURE.md) · [PROVIDERS.md](./PROVIDERS.md) ·
[FREE_TIERS.md](./FREE_TIERS.md) · [SECURITY.md](./SECURITY.md) · [TESTING.md](./TESTING.md) ·
[ENV_VARS.md](./ENV_VARS.md)

## Architecture

```
USER
 ↓
API GATEWAY            (node:http server, bearer auth, token-bucket rate limit)
 ↓
REQUEST ANALYZER       (task classification, difficulty 1–5, vision/long-context/tool flags)
 ↓
MODEL/PROVIDER REGISTRY(seed registry + live catalog refresh from Puter)
 ↓
LIVE PROVIDER STATE    (circuit breakers, latency EMA, rpm/tpm windows, quota exhaustion)
 ↓
DECISION ENGINE        (deterministic per-mode scoring + AI decision-model re-rank)
 ↓
ROUTING ENGINE         (execute → validate → classify → retry → failover → shrink)
 ↓
PROVIDER EXECUTION     (Puter wrapper HTTP client, SSE streaming, direct-driver fallback)
 ↓
RESPONSE VALIDATION    (empty content + no tool_calls = malformed; OpenAI-shaped output)
```

On failure: error classification (rate_limit / auth / quota_exhausted / context_overflow /
unsupported_capability / malformed_response / timeout / connection / server) drives
retry-once-then-switch, capability-compatible failover, and context shrink for overflow.

### Project structure

```
router/
├── src/
│   ├── server.ts                 # entrypoint
│   ├── api/server.ts             # HTTP API, auth, rate limit, pinned-model routing
│   ├── core/types.ts             # ProviderAdapter interface + shared domain types
│   ├── core/config.ts            # env loading + parseMode
│   ├── analysis/tokens.ts        # token estimation
│   ├── analysis/analyzer.ts      # task classification + difficulty estimation
│   ├── registry/registry.ts      # seed model registry + live catalog merge
│   ├── state/state.ts            # circuit breakers, health, quota, rate windows
│   ├── errors/classify.ts        # error taxonomy + retryability rules
│   ├── providers/puter.ts        # Puter wrapper adapter (chat, stream, discovery)
│   ├── decision/decision.ts      # deterministic scoring + decideRouting
│   ├── decision/ai-selector.ts   # AI decision model (strict JSON order extraction)
│   ├── routing/engine.ts         # the routing loop (retry/failover/shrink)
│   └── util/ids.ts
├── tests/
│   ├── unit/                     # analyzer, error classification, state store
│   ├── integration/              # full routing vs a local mock Puter wrapper
│   ├── e2e/live.e2e.test.ts      # real server + real wrapper (skips without creds)
│   └── helpers/                  # mock wrapper + test harness
├── ENV_VARS.md                   # full environment contract
└── README.md
```

## Providers

The router is genuinely multi-provider: every provider implements `ProviderAdapter`
(`listModels`, `capabilities`, `contextLimit`, `healthCheck`, `quota`, `chat`, `stream`,
`supports`, `usage`, `classifyError`, `listModelsSync`), registers in `src/api/server.ts`
when its credential is present, and competes for every request in the same scoring pool.

| Provider | Adapter | Credential | Status in this workspace |
|---|---|---|---|
| Puter (wrapper) | `providers/puter.ts` | `PUTER_WRAPPER_KEY` | **live-verified** (primary) |
| Puter (direct driver) | `providers/puter-direct.ts` | `PUTER_API_KEY` or `PUTER_DIRECT_TOKEN` | **live-verified** — separate failure domain; real wrapper-outage failover tested |
| Google AI Studio (Gemini) | `providers/google-ai-studio.ts` | `GOOGLE_API_KEY` / `GEMINI_API_KEY` | implemented, unverified (no key here); permanent free tier confirmed in official docs |
| Groq | `providers/groq.ts` | `GROQ_API_KEY` | implemented, unverified (no key here) |
| OpenRouter | `providers/openrouter.ts` | `OPENROUTER_API_KEY` | implemented, unverified (no key here) |
| Mistral | `providers/mistral.ts` | `MISTRAL_API_KEY` | implemented, unverified (no key here) |
| NVIDIA NIM | `providers/nvidia.ts` | `NVIDIA_API_KEY` | implemented, unverified (no key here); credit-based, not permanent free |
| Cerebras | `providers/cerebras.ts` | `CEREBRAS_API_KEY` | implemented, unverified; **trial credits only — officially NOT permanent free** |

See [PROVIDERS.md](./PROVIDERS.md) for research status and
[FREE_TIERS.md](./FREE_TIERS.md) for sourced per-provider limits.

- **Puter wrapper** — OpenAI-compatible gateway in front of Puter's 1000+ model catalog
  (user-pays driver path; metered against the Puter account's free allowance). The
  adapter owns the HTTP client, live catalog discovery, health probing, SSE streaming,
  and error classification.
- **Puter direct** — talks straight to `api.puter.com/drivers/call` (newline-delimited
  JSON stream events `{"type":"text",...}` + `{"type":"usage",...}`), a genuinely
  separate host/auth/payload path. When the wrapper host is unreachable the engine
  fails over across providers in-flight (verified live). Model ids are namespaced
  (`puter-direct:vendor/model`) so both providers coexist in one registry.
- **Groq** (free tier ≈30 RPM / 6k TPM / 1k RPD per model, verified 2026-09 docs) and
  **OpenRouter** (free `:free` models, 20 RPM / 50 RPD — 1000 RPD after $10 credits)
  share the `OpenAiCompatAdapter` base: `/models` discovery, per-model capability
  mapping, free-tier-aware cost/tier classification, SSE streaming, and 429/402-driven
  quota state. They activate automatically when their env keys are set.

Adding a provider = implement `ProviderAdapter` (or subclass `OpenAiCompatAdapter`)
+ one registration block. NVIDIA NIM, Cloudflare Workers AI, Mistral, Cerebras,
SambaNova, Cohere and Hugging Face were evaluated and can be added the same way;
they were not registered because their current free tiers require credentials not
available in this workspace (verified against current provider docs, 2026-09).

## The AI decision model

The router's internal "brain" re-ranks the deterministic top-8 candidates per request.

**Selected: `google:google/gemini-3.5-flash-lite`** (configurable via
`ROUTER_DECISION_MODEL`, fallbacks via `ROUTER_DECISION_FALLBACK_MODELS`).

Evidence from live probes through the wrapper (2026-09-26):

| Candidate | Behavior | Verdict |
|---|---|---|
| `google:google/gemini-3.5-flash-lite` | Clean minified `{"order":[...]}` JSON, ~0.68 s, 1 M context | **selected** |
| `deepseek:deepseek/deepseek-v4-flash` | Returned reasoning + JSON, ~1.25 s | fallback #1 |
| `openai:openai/gpt-5-nano` | Empty content, `finish_reason: "length"` at 100 tokens | rejected (weak instruction following) |

Why it fits: strict instruction following for structured output, sub-second latency (the
decision happens inline before the main request), 1 M-token context, light-tier cost, and
it conserves the account's metered free allowance. The selector is prompted to return
**only** `{"order":["<model-id>",...]}`; a strict JSON extraction falls through the
fallback chain and finally to deterministic-only routing on any failure.

Rules enforced around the AI brain:

- AI output can only reorder the candidate pool that already passed hard filters
  (tools / vision / context / health / quota) — it can never reintroduce an ineligible model.
- **FREE mode never calls the AI brain and never applies its order** — cost is the binding
  constraint and only the deterministic cost-weighted score sees live allowance data.
- `ROUTER_RULES_ONLY=1` disables the AI layer entirely (deterministic routing).

## Routing modes

| Mode | Behavior |
|---|---|
| `auto` | Full intelligent routing (default). Capability 0.35, cost 0.2, speed 0.15, health 0.2, fit 0.1. |
| `fast` | Latency-first while remaining task-capable (speed 0.45). |
| `quality` | Strongest suitable models (capability 0.55). |
| `reasoning` | Strong reasoning for hard tasks (capability + task-fit weighted). |
| `free` | Optimizes legitimate free capacity: cost 0.45, and for tasks with difficulty ≤ 3 the pool is **restricted to light/mid tiers** (allowance conservation). Hard filters already guarantee capability-compatibility; if nothing cheap can serve the request the full pool is kept. |
| `balanced` | Even quality/speed/reliability/allowance weighting. |

Modes are chosen with `routing_mode` on the request body; `model: "router-auto"` is a
compatibility alias for full auto. An explicit `model` pins that model (honored first,
with live failover to the best candidate).

## Top-model priority behavior

Top-tier models (`openai:openai/gpt-5.6-sol`, `gpt-6-sol`,
`anthropic:anthropic/claude-opus-5-5`, `google:google/gemini-3.8-flash`, …) receive high
priority in capability-weighted modes and win on hard tasks (difficulty ≥ 4 — verified
live: a distributed-systems/security-audit prompt routed to `gpt-6-sol`). But priority ≠
always-select: simple tasks fit light/mid tiers via the task-fit term, and any top model
that is circuit-open, rate-limited, quota-exhausted, or context-insufficient is filtered
or demoted dynamically. Failover walks the remaining scored candidates, not a static chain.

## Huge prompts

- Token estimation before execution; models with insufficient context are hard-filtered.
- Estimated context requirement = prompt tokens + 25 % headroom for completion.
- If the upstream reports context overflow, the engine shrinks history (preserving system
  messages, the first user message, and the final message; middle history dropped
  oldest-first) to ~60 % of the limit and retries the same model; if it cannot shrink
  further it fails over to a larger-context model.
- Long-context tasks preferentially rank 1 M-context models (qwen-flash family,
  gemini-3.x, gpt-5.6 family).

## Free capacity as a routing resource

Tracked in `state/state.ts`: per-minute rpm/tpm windows, latency EMA, consecutive-failure
circuit breakers (3 failures → open, exponential-jitter cooldown), quota exhaustion
(cooldown on upstream 429/402), and per-provider health. Puter is user-pays: the upstream
account's free allowance is the real budget, the router never assumes unlimited access,
and free mode conserves it by preferring the cheapest capable tier. Quota events surface
in the routing trace and in `/v1/state`.

## API

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness across all registered providers + state snapshot |
| GET | `/v1/models` | Union registry (all providers) with context/tier/cost/capabilities |
| GET | `/v1/state` | Per-provider registered models, health, quota intelligence, rate windows |
| POST | `/v1/chat/completions` | OpenAI-compatible completions; `routing_mode` field; `stream: true` → SSE ending `data: [DONE]` |

Requests need `Authorization: Bearer $ROUTER_API_KEY` (when configured) and are subject to
the token-bucket rate limit (`ROUTER_RATE_LIMIT_PER_MIN` per client IP). Every completion
carries a `router` trace: mode, task analysis, decision (source, score, candidates,
rejected + reasons, decision latency), per-attempt provider/model/duration/TTFT/errors,
retry and fallback counts. Errors are sanitized (Bearer tokens / JWTs redacted) and never
echo secrets or prompts.

## Environment variables

See [ENV_VARS.md](./ENV_VARS.md) for the full contract. Key variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4141` | HTTP listen port |
| `ROUTER_API_KEY` | — | Required bearer key when set |
| `PUTER_WRAPPER_BASE` | `https://daii.freebuff.app` | Existing Puter wrapper base URL |
| `PUTER_WRAPPER_KEY` | — | Bearer key for the wrapper |
| `PUTER_DIRECT_TOKEN` | — | Optional: enables the wrapper adapter's internal driver fallback |
| `PUTER_API_KEY` | — | Puter API key; activates the puter-direct provider |
| `PUTER_DIRECT_ENABLED` | `1` | `0` disables the puter-direct provider |
| `GROQ_API_KEY` | — | Activates the Groq provider |
| `OPENROUTER_API_KEY` | — | Activates the OpenRouter provider |
| `ROUTER_DECISION_MODEL` | `google:google/gemini-3.5-flash-lite` | AI decision model |
| `ROUTER_DECISION_FALLBACK_MODELS` | `deepseek:deepseek/deepseek-v4-flash` | Comma-separated fallbacks |
| `ROUTER_DECISION_TIMEOUT_MS` | `6000` | AI decision timeout |
| `ROUTER_RULES_ONLY` | — | `1` disables the AI decision layer |
| `ROUTER_MAX_RETRIES` | `2` | Retries + failovers per request |
| `ROUTER_TIMEOUT_MS` | `120000` | Upstream call timeout |
| `ROUTER_RATE_LIMIT_PER_MIN` | `120` | Per-IP request cap |

## Running

```bash
bun install            # or npm install
bun run dev            # tsx watch, dev server
bun run build          # tsc → dist/
bun run start          # node dist/server.js
```

## Verification commands

```bash
cd router
bun run typecheck                                   # tsc --noEmit (= lint)
bun run test:unit                                   # 37 unit tests
bun run test:integration                            # 140 integration tests
PUTER_WRAPPER_KEY=<key> bun run test:e2e            # 12 live E2E tests (skips without key)
bun run build                                       # tsc → dist/

# live probes
PUTER_WRAPPER_KEY=… PUTER_API_KEY=… bun scripts/probe-multi.ts   # both Puter paths
PUTER_WRAPPER_KEY=… bun scripts/bench.ts                        # routing benchmark
```

Current results: typecheck/lint clean · unit **37/37** · integration **140/140** ·
E2E **12/12** (live, incl. real cross-provider failover) · build clean.

## Test coverage

- **Unit (37)** — analyzer task classification/difficulty/signals; error taxonomy,
  retryability, sanitization; state store (circuit breaker open/cooldown/recovery, rate
  windows, health EMA, quota exhaustion).
- **Integration (140)** — against a local mock Puter wrapper: all six modes, tool-calling,
  vision filtering, huge-context shrink + failover, HTTP status matrix (401/402/403/404/
  408/409/413/422/429/5xx), timeout, connection failure, malformed responses, quota
  exhaustion, provider outage, retry/backoff, circuit breaker, streaming, structured
  output, auth, rate limit — plus scripted stub-provider suites: cross-provider failover
  (per-error-kind matrix with attempt-history preservation), adversarial streaming
  (mid-stream death, malformed SSE, duplicates, usage-before-text, stalls), concurrency
  (1–50 parallel, state consistency, secret-leak checks), circuit-breaker lifecycle
  (half-open recovery incl. regression test), catalog resilience, huge-context stress,
  FREE-mode paid-fallback policy, and AI decision-layer audits (injection, duplicates,
  ghost models, decision-model 429/5xx/auth, enormous candidate lists) — plus OpenAI-compat
  wire contracts for the Groq/OpenRouter adapters against a mock OpenAI server (discovery
  mapping, wire shape, error matrix, streaming; see TESTING.md).
- **E2E (12, live)** — boots the real server with the real wrapper: health, live catalog
  models, auto-routing (trivial → cheap model, AI decision source), hard task → top-tier
  (`gpt-6-sol` observed), quality mode, **free mode → cheap-band model (chosen model's live
  catalog cost ≤ 10 ¢/MTok)**, tool-calling end-to-end, pinned-model honoring, SSE
  streaming with `[DONE]`, 400 on invalid requests, puter-direct registration, and
  **real cross-provider failover: wrapper host unreachable → request completes via the
  puter-direct provider**.

## Known limitations

- `n > 1` completions are not supported by the Puter driver path (single choice only).
- Puter exposes no `:free` model variants; "free" means user-pays metering against the
  account's free allowance, not unlimited access.
- Quota/daily-budget tracking is heuristic (reactive to 429/402) — Puter exposes no quota
  query API to the wrapper.
- The AI decision layer adds ~0.7–0.9 s to auto/quality/reasoning routes (measured,
  see `scripts/bench.ts`); disable with `ROUTER_RULES_ONLY=1` for latency-critical runs.
- Groq/OpenRouter adapters are complete but unverified against live APIs (no keys in this
  workspace); first live calls should be smoke-tested before production reliance.

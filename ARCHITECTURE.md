# Architecture

## Request lifecycle

```
USER
 ↓
API GATEWAY (node:http, 0.0.0.0:$PORT)
│   bearer auth (ROUTER_API_KEY) · per-IP token-bucket rate limit
│   8 MB body cap · request validation · sanitized errors
 ↓
REQUEST ANALYZER (analysis/analyzer.ts)
│   task type (chat/reasoning/coding/long_context/tool_use/multimodal/…)
│   difficulty 1–5 · requiresTools/Vision/LongContext/Reasoning
│   token estimation (analysis/tokens.ts)          ~0.005 ms
 ↓
MODEL/PROVIDER REGISTRY (registry/registry.ts)
│   one shared registry, provider-namespaced ids ("puter:…", "groq:…", "puter-direct:…")
│   seed metadata + live catalog refresh per provider (cost/context/modalities)
 ↓
LIVE PROVIDER STATE (state/state.ts, one ProviderStateStore per provider)
│   circuit breakers (open → cooldown → half-open → closed)
│   latency + TTFT EMA · rpm/tpm minute windows · UTC-daily token/request counters
│   quota policies (known limits) + reactive observations (429/402 + Retry-After)
 ↓
DECISION ENGINE (decision/)
│   1. scoreCandidates: HARD FILTERS (tools/vision/context/health/quota/circuit)
│      then per-mode soft scoring (capability/cost/speed/health/fit)
│      FREE mode: restricts pool to light/mid tiers for difficulty ≤ 3
│   2. AI decision model (optional, skipped in FREE + rules-only):
│      re-ranks ONLY the top-8 scored candidates; strict JSON order extraction
│      with fallback chain; truncation retry (empty content + finish_reason length)
│   3. decideRouting: applies AI order inside the hard-filtered pool, or
│      FREE-mode reject/allow-paid policy when no cheap candidate exists
 ↓
ROUTING ENGINE (routing/engine.ts)
│   execute → validate (empty content + no tool_calls = malformed)
│   → classify (errors/classify.ts: 10-kind taxonomy + Retry-After)
│   → retry same model once (attempt 1, retryable) → failover
│   → failover is PROVIDER-AWARE: provider-level failures (timeout/connection/
│     5xx/429/quota) prefer a DIFFERENT provider; capability filters still apply
│   → context overflow: shrink history (keep system + first user + final msg)
│     to 60% and retry same model; if unshrinkable, fail over
 ↓
PROVIDER EXECUTION (providers/*)
│   per-adapter HTTP clients; no cross-provider knowledge; streaming with
│   idle-read watchdogs; direct-driver last-resort inside the Puter adapter
 ↓
RESPONSE VALIDATION → OpenAI-shaped completion + router trace
```

## Module map

| Module | Responsibility |
|---|---|
| `api/server.ts` | HTTP surface, auth, rate limit, provider registration, pinned-model routing, SSE re-emission |
| `api/sanitize.ts` | credential stripping for error messages |
| `core/types.ts` | `ProviderAdapter` contract + wire/domain types |
| `core/config.ts` | env loading, `QuotaPolicy`, `parseMode` |
| `analysis/` | task analysis + token estimation |
| `registry/registry.ts` | shared model registry with refresh-safe merging |
| `state/state.ts` | per-provider health, circuit breakers, quota intelligence |
| `errors/classify.ts` | HTTP-status matrix, network error mapping, Retry-After |
| `decision/decision.ts` | deterministic scoring + mode weights + FREE policy |
| `decision/ai-selector.ts` | AI brain with hard JSON contract + fallbacks |
| `routing/engine.ts` | the routing loop (retry/failover/shrink/trace) |
| `providers/*` | one adapter per provider; `openai-compat.ts` shared base |

## Design invariants

1. **Hard filters are absolute.** No code path (AI, failover, pinning) can execute a
   model that failed capability/context/health/quota filtering.
2. **AI can only reorder.** The decision model sees the top-8 scored candidates and
   returns an order; unknown ids are dropped; failures fall back to deterministic order.
3. **FREE mode never silently spends money.** If only expensive candidates remain,
   the configured policy applies (`reject` default → clear error; `allow-paid` opt-in).
4. **Failover is capability-preserving and provider-aware.** Same-pool failover for
   model-level errors; cross-provider preference for provider-level errors.
5. **Quota is never assumed unlimited.** Known limits come from documented policies
   with confidence levels; unknown limits are reactive (429/402 + Retry-After) with
   UTC-daily reset windows.
6. **Circuit breakers recover.** OPEN is cooldown-scoped; expiry yields HALF-OPEN
   (probe allowed); success closes, failure re-arms a longer cooldown.

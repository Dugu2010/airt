# Testing

## Suites

| Suite | Location | What it covers |
|---|---|---|
| Unit | `tests/unit/` | analyzer (task classification, difficulty, signals, token estimation), error taxonomy + sanitization, state store (breakers, windows, quota) |
| Integration | `tests/integration/` | full routing against a local mock Puter wrapper, cross-provider stub failover, AI decision audits, adversarial streaming, concurrency, circuit recovery, catalog resilience, huge context, security, failover matrix, OpenAI-compat wire contracts (Groq/OpenRouter vs a mock OpenAI server) |
| E2E (live) | `tests/e2e/live.e2e.test.ts` | real router server + real Puter wrapper: modes, tool-calling, streaming, pinned models, puter-direct registration, **real cross-provider failover with a dead wrapper host**. Auto-skips without credentials. |

## Adversarial streaming coverage

`tests/integration/adversarial-streaming.test.ts` runs a local hostile SSE server:

- connection dies mid-stream → partial text yielded, then error surfaces (never silent)
- malformed SSE lines / invalid JSON → skipped without crashing
- empty deltas, unknown event shapes, duplicate chunks → handled
- usage arriving before final text → captured
- omitted final event / HTTP 200 with non-SSE schema → clean empty or partial result
- slow multi-read streams → fine; total-silence stalls → idle-read watchdog error

Contract: adapters surface connection death as errors; the server layer decides
partial-vs-failover; nothing silently concatenates incompatible partials.

## Concurrency

`tests/integration/concurrency.test.ts` (deterministic stubs — no real quotas):
1 / 5 / 10 / 25 / 50 simultaneous requests, plus 100 sequential. Asserts
counter consistency (`rpm` equals requests started), correct circuit behavior
under parallel failure, zero secret leakage in traces, and healthy-provider
distribution when one provider fails.

## OpenAI-compat wire contracts

`tests/integration/openai-compat.test.ts` runs the **Groq and OpenRouter adapters**
against a local mock server speaking the OpenAI wire protocol. These providers have no
credentials in this workspace (live verification impossible), so this suite is their
contract guard: /models discovery mapping (context, tools, vision, pricing → cost,
`:free` detection, tier classification), wire-request shape (bearer auth, namespaced-id
stripping, `max_tokens → max_completion_tokens`, passthrough of temperature/tool_choice/
response_format/seed), tool-call mapping, SSE streaming (deltas + usage + `[DONE]`), the
full HTTP error matrix (429 + Retry-After, 401, 402, context-overflow message, 503, 404,
malformed JSON, missing message shape), discovery-failure fallback, and the
`supports()` ownership/capability contract. When real keys appear,
`scripts/probe-multi.ts` provides the live smoke test.

## Circuit-breaker lifecycle

`tests/integration/circuit-recovery.test.ts`: CLOSED → 3 failures → OPEN →
cooldown → HALF-OPEN → success → CLOSED; half-open probe failure re-arms a
longer cooldown; provider recovery and persistent-death flows; daily quota
exhaustion vs restart semantics.

## Commands

```bash
bun run typecheck        # tsc --noEmit (also = lint)
bun run lint             # same as typecheck
bun run test:unit        # unit suite
bun run test:integration # integration suite (mock servers, no live calls)
bun run test:e2e         # live E2E (needs PUTER_WRAPPER_KEY; skips without it)
bun run test             # unit + integration + e2e
bun run build            # tsc → dist/

# live provider probes (require the matching env keys)
PUTER_WRAPPER_KEY=… PUTER_API_KEY=… bun scripts/probe-multi.ts
PUTER_WRAPPER_KEY=… bun scripts/bench.ts
```

## Live E2E credentials

The E2E suite is real: it boots `src/api/server.ts` with the configured wrapper and
exercises the full request path. Without `PUTER_WRAPPER_KEY` the suite skips (CI-safe).
The dead-wrapper failover test additionally uses `PUTER_API_KEY` (or
`PUTER_DIRECT_TOKEN`) to prove traffic lands on the puter-direct provider.

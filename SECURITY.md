# Security Model

## Authentication & authorization

- `ROUTER_API_KEY` (when set) is required as `Authorization: Bearer <key>` on `/v1/*`.
  Without it the API is open by design (single-tenant deployments); set the key in
  production. Health/state endpoints are unauthenticated and expose no prompt data.
- Client authorization is uniform: a valid client key grants routing access; it never
  selects providers or bypasses quota/health rules.

## Request validation & limits

- `messages` must be a non-empty array; invalid JSON → 400 with OpenAI-style error.
- Request bodies are capped at **8 MB** (stream-guarded read; oversized bodies are
  rejected before routing).
- Per-IP token-bucket rate limiting (`ROUTER_RATE_LIMIT_PER_MIN`, default 60) on chat
  completions.
- Upstream call timeout (`ROUTER_TIMEOUT_MS`) on every provider request; streaming has
  an additional **idle-read watchdog** so a stalled stream errors instead of hanging.
- Tool/capability restrictions are enforced deterministically (hard filters), not by
  prompt instructions — prompt injection cannot change routing (tested).

## SSRF posture

- Provider endpoints are **hardcoded constants per adapter** (`api/server.ts` and the
  provider modules). The router never fetches a URL derived from user input.
- The only client-influenced upstream value is the model id, which must match a registry
  entry owned by a registered provider (`capabilities()` ownership filter); unknown ids
  are never executed.
- No arbitrary header forwarding: adapters send only `Authorization` + `Content-Type`;
  client headers are never proxied upstream.

## Secret handling

- All credentials enter via environment variables (`PUTER_WRAPPER_KEY`, `PUTER_API_KEY`,
  `GROQ_API_KEY`, …). None are logged, traced, or embedded in errors.
- `src/api/sanitize.ts` strips credential-shaped material (Bearer tokens, JWTs, `sk-*`
  keys, `api_key=/key=/token=` query params) from any error message that reaches a
  client or log. Verified by tests using a real-format key.
- Traces (`response.router`) contain ids, model names, scores, latencies, error kinds —
  never prompts, responses, or credentials (asserted by concurrency + security tests).
- Provider state snapshots (`/v1/state`) expose counters and health, not secrets.

## Quota fairness

- Exhausted providers (429/402, Retry-After honored, policy daily caps) are removed
  from the candidate pool until cooldown/reset — the router never hammers a depleted
  upstream and never bypasses provider safeguards.

## Dependency posture

- Runtime dependencies: `dotenv` only. No dynamic code execution, no eval, no child
  processes in the request path. Audit with `bun pm ls` / `npm audit` as needed.

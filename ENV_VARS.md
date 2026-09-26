# Router environment variables

Copy these into `router/.env.local` (or export them). `.env.local` is gitignored.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `4141` | HTTP API port |
| `ROUTER_API_KEY` | no | (open) | Client auth: require `Authorization: Bearer <key>` on `/v1/*` |
| `PUTER_WRAPPER_BASE` | yes | `https://daii.freebuff.app` | Base URL of the existing Puter wrapper endpoint |
| `PUTER_WRAPPER_KEY` | yes (if wrapper locked) | — | The wrapper's `GATEWAY_API_KEY` |
| `PUTER_DIRECT_TOKEN` | no | — | Enables the wrapper adapter's internal last-resort direct-driver fallback |
| `PUTER_API_KEY` | no | — | Puter API key; activates the **puter-direct** provider (api.puter.com/drivers/call) |
| `PUTER_DIRECT_ENABLED` | no | `1` | `0` disables the puter-direct provider |
| `GOOGLE_API_KEY` / `GEMINI_API_KEY` | no | — | Activates the **Google AI Studio** provider (permanent free tier; per-project RPM/TPM/RPD) |
| `GROQ_API_KEY` | no | — | Activates the **Groq** provider (free tier ≈30 RPM / 6k TPM / 1k RPD per model) |
| `OPENROUTER_API_KEY` | no | — | Activates the **OpenRouter** provider (free `:free` models: 20 RPM / 50 RPD, 1000 RPD after $10 credits) |
| `MISTRAL_API_KEY` | no | — | Activates the **Mistral** provider (free experimental plan) |
| `NVIDIA_API_KEY` / `NIM_API_KEY` | no | — | Activates the **NVIDIA NIM** provider (credit-based; not permanent free) |
| `CEREBRAS_API_KEY` | no | — | Activates the **Cerebras** provider ($5 trial credits only — NOT permanent free) |
| `ROUTER_FREE_FIRST` | no | `1` | `1` = every routing mode prefers capable free-tier models (quota headroom-aware) before paid capacity; `0` = classic pure-score selection |
| `ROUTER_FREE_FALLBACK` | no | `reject` | FREE mode when no capable free/cheap candidate exists: `reject` = refuse with a clear error (never silently spend); `allow-paid` = permit paid fallback |
| `ROUTER_DECISION_MODEL` | no | `google:google/gemini-3.5-flash-lite` | Puter model used for internal AI decisions |
| `ROUTER_DECISION_FALLBACK_MODELS` | no | `deepseek:deepseek/deepseek-v4-flash,openai:openai/gpt-5-nano` | Decision-model fallback chain |
| `ROUTER_DECISION_TIMEOUT_MS` | no | `20000` | Decision call timeout |
| `ROUTER_RULES_ONLY` | no | `0` | `1` = disable AI decisions, use deterministic scorer only |
| `ROUTER_MAX_RETRIES` | no | `3` | Max execution attempts per request |
| `ROUTER_TIMEOUT_MS` | no | `120000` | Per-attempt upstream timeout |
| `ROUTER_RATE_LIMIT_PER_MIN` | no | `60` | Client rate limit on `/v1/chat/completions` |

Note on "free": the Puter path used here is the **user-pays driver** — usage is metered to the
Puter account's free allowance, with overage billed by Puter. It is not an unlimited free tier.

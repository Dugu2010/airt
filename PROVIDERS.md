# Provider Registry & Free-Tier Research

Researched: **2026-09-26**. Provider limits change without notice — re-verify before
production reliance. "Verified" means checked against the provider's own documentation
on the date shown. Nothing in this project claims unlimited usage.

## Active in this workspace (live-verified)

| Provider | Adapter | Endpoint | Auth | Free capacity |
|---|---|---|---|---|
| Puter (wrapper) | `providers/puter.ts` | `PUTER_WRAPPER_BASE/v1/chat/completions` | `PUTER_WRAPPER_KEY` bearer | **User-pays metering** against the account's free allowance. NOT unlimited. Verified live: 203 models, chat + streaming. |
| Puter (direct) | `providers/puter-direct.ts` | `api.puter.com/drivers/call` | `PUTER_API_KEY`/`PUTER_DIRECT_TOKEN` bearer | Same user-pays metering, separate host/auth/payload path (distinct failure domain). Verified live: 201 models, chat + newline-JSON streaming. |

Puter official OpenAI endpoint (`/puterai/openai/v1`) verified live 2026-09-26: returns
**402 `subscription_required`** on free accounts — the driver path is the only legitimate
free route. No `:free` model variants exist in Puter's catalog (1,030+ ids checked).

## Implemented, awaiting credentials (mocked coverage only)

| Provider | Adapter | Endpoint | Auth env var | Research status |
|---|---|---|---|---|
| Google AI Studio (Gemini) | `providers/google-ai-studio.ts` | `generativelanguage.googleapis.com/v1beta/openai/` | `GOOGLE_API_KEY` / `GEMINI_API_KEY` | **Permanent free tier CONFIRMED** (official docs, see FREE_TIERS.md). Per-model RPD ~10–20 for flash models is a third-party estimate, not Google-published. |
| Groq | `providers/groq.ts` | `api.groq.com/openai/v1` | `GROQ_API_KEY` | Free tier confirmed by multiple current sources incl. official rate-limits docs (30 RPM / 6k TPM / ~1k RPD class, per model). Medium confidence on exact numbers. |
| OpenRouter | `providers/openrouter.ts` | `openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | Free `:free` models confirmed by official docs: 20 RPM; 50 RPD fresh accounts, 1000 RPD after one-time $10 credit purchase. |
| Mistral La Plateforme | `providers/mistral.ts` | `api.mistral.ai/v1` | `MISTRAL_API_KEY` | Free "experimental" plan reported (~1 req/s, large monthly tokens; phone + opt-in required). Medium confidence. |
| NVIDIA NIM | `providers/nvidia.ts` | `integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` / `NIM_API_KEY` | **Credit-based trial allocation — NOT a documented permanent free tier.** |
| Cerebras | `providers/cerebras.ts` | `api.cerebras.ai/v1` | `CEREBRAS_API_KEY` | **Official FAQ 2026-09-26: NO permanently free tier.** $5 trial credits, expire 30 days, payment method required. Registered only for paid-capability coverage; never advertised as free. |

## Evaluated and intentionally not implemented

| Provider | Reason (as of 2026-09-26) |
|---|---|
| Cloudflare Workers AI | Free allocation exists but is neuron-unit based and tied to a Cloudflare account/plan; requires `CLOUDFLARE_API_TOKEN` + account ID plumbing not present here. |
| Hugging Face Inference API | Free tier heavily rate-limited and model-rotating; serverless endpoints deprecated in favor of paid routers. Not high-value for routing. |
| SambaNova | No documented permanent free API tier; trial/credit based. |
| Cohere | Trial keys are rate-limited for development only; production requires payment. Marginal value. |
| Together AI / Fireworks AI | Signup credits only; no permanent free tier documented. |
| xAI / Anthropic / OpenAI direct | No free API tier (OpenAI/Anthropic), xAI requires existing credits. |

## Adding a new provider

1. Implement `ProviderAdapter` (from `src/core/types.ts`) or subclass
   `OpenAiCompatAdapter` if the provider speaks OpenAI wire format.
2. Map `/models` rows into `ProviderModelInfo` (id namespaced `provider:`,
   context, tools/vision, cost, tier).
3. Register in `src/api/server.ts` behind a credential check, and attach a
   `QuotaPolicy` via `state.setQuotaPolicy(...)` with source + confidence.
4. Add integration coverage (stub or mock server) and mark verification status
   in this file. Never claim live verification without a live probe.

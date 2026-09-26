# Free-Tier Reference (with sources and dates)

Researched **2026-09-26**. Provider limits change frequently — always re-verify against
the linked official source before relying on any number. "Confirmed" = read directly from
the provider's own documentation. "Estimate" = reported by current third-party trackers;
not provider-published. **Nothing here is unlimited** unless a provider's own docs say so.

## Puter (user-pays metering) — the workspace's active capacity

- Access: free Puter account → API token → user-pays driver
  (`POST https://api.puter.com/drivers/call`, `interface: "puter-chat-completion"`).
- Semantics: usage is **metered against the account's free allowance**, with overage
  billed by Puter. This is *user-pays metering*, not a free quota.
- Model pricing: `https://api.puter.com/puterai/chat/models/details` publishes
  per-model `costs.prompt_tokens` / `costs.completion_tokens` in US cents per 1M tokens.
- No `:free` variants exist in the catalog.
- Source: https://docs.puter.com / live API checks (2026-09-26). **Confirmed.**

## Google AI Studio (Gemini API)

- **Permanent free tier: confirmed.** Usage tier "Free" requires only an active project
  (no billing account): https://ai.google.dev/gemini-api/docs/rate-limits
- Limits are per project across RPM, TPM, and RPD. **RPD resets at midnight Pacific
  (confirmed)**; token buckets replenish per the published quotas.
- Exact per-model free-tier RPD is displayed inside AI Studio and is not published as a
  stable table on the docs page. Current flash models are reported at roughly **10–20
  requests/day** (third-party estimates, e.g. scriptbyai.com 2026-09 — *estimate*).
- Credit card: not required. Payment: not required for the Free tier.
- OpenAI-compatible endpoint: `https://generativelanguage.googleapis.com/v1beta/openai/`
  (confirmed from the same docs site).

## Groq

- Free tier: confirmed to exist (no credit card) per
  https://console.groq.com/docs/rate-limits (accessed 2026-09).
- Reported class: **30 RPM / 6k TPM / ~1k RPD per model** on standard models, half for
  some (Llama 4 Maverick 15 RPM / 3k TPM / 500 RPD) — *estimate* from current third-party
  trackers (tokenmix.ai, klymentiev.com 2026-05/09); the authoritative live numbers are
  shown per-account in the Groq console.
- Quota reset: per-minute/daily windows (standard rolling windows).

## OpenRouter

- Free models (`:free` suffix): confirmed by
  https://openrouter.ai/docs/api_reference/limits and https://openrouter.ai/pricing.
- Limits: **20 requests/minute; 50 requests/day on accounts that have never purchased
  credits; 1000 requests/day after a one-time $10 credit purchase** (confirmed).
- The 20 RPM cap stays even after credits (*confirmed*).
- Free models are rate-limited per-account, not per-model.

## Mistral La Plateforme

- Free "experimental" plan: reported by current guides (~1 req/s, ~500k TPM, ~1B
  tokens/month, phone verification + consent to data training required) — *estimate*,
  medium confidence. Official terms: https://docs.mistral.ai/ (2026-09).
- Not unlimited; requires an activated account.

## Cerebras — explicitly NOT permanent free

- Official FAQ (https://inference-docs.cerebras.ai/support/rate-limits, read 2026-09-26):
  **"Is there a permanently free tier? No."** New accounts get **$5 trial credits that
  expire after 30 days** and require adding a verified payment method before API access.
- Free Trial tier rate limits (confirmed): 5 RPM / 30K uncached TPM / 90K total TPM /
  1M TPH / 1M TPD per model.
- Classification: **temporary promotional credits**, never advertised by this router
  as free capacity.

## NVIDIA NIM (build.nvidia.com hosted endpoints)

- Credit-based allocation on signup (account-dependent; commonly 1000+ credits).
  **Not a documented permanent free tier; not unlimited.** *Estimate/medium confidence.*
- Source: https://build.nvidia.com (2026-09).

## Evaluated: no meaningful free API tier (as of 2026-09-26)

Cloudflare Workers AI (neuron-unit allocation, account plumbing required), Hugging Face
(deprecated serverless free tier, heavy limits), SambaNova (trial only), Cohere
(dev-limited trial keys), Together AI (signup credits), Fireworks AI (signup credits),
xAI / Anthropic / OpenAI direct (paid only).

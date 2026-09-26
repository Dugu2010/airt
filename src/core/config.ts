import type { RoutingMode } from "./types.js";

export interface RouterConfig {
  port: number;
  routerApiKey: string | null;
  puterWrapperBase: string;
  puterWrapperKey: string | null;
  puterDirectToken: string | null;
  decisionModel: string;
  decisionFallbackModels: string[];
  decisionTimeoutMs: number;
  rulesOnly: boolean;
  maxRetries: number;
  timeoutMs: number;
  rateLimitPerMin: number;
  // ---- multi-provider ----
  puterApiKey: string | null;
  groqApiKey: string | null;
  openrouterApiKey: string | null;
  googleApiKey: string | null;
  cerebrasApiKey: string | null;
  mistralApiKey: string | null;
  nvidiaApiKey: string | null;
  puterDirectEnabled: boolean;
  /** FREE-mode behavior when no capable free provider can serve the task. */
  freeFallbackPolicy: "reject" | "allow-paid";
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === "" ? undefined : v;
}

function num(name: string, fallback: number): number {
  const v = Number(env(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function loadConfig(): RouterConfig {
  const decisionModel = env("ROUTER_DECISION_MODEL") ?? "google:google/gemini-3.5-flash-lite";
  const fallbacks =
    env("ROUTER_DECISION_FALLBACK_MODELS")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? ["deepseek:deepseek/deepseek-v4-flash", "openai:openai/gpt-5-nano"];

  return {
    port: num("PORT", 4141),
    routerApiKey: env("ROUTER_API_KEY") ?? null,
    puterWrapperBase: (env("PUTER_WRAPPER_BASE") ?? "https://daii.freebuff.app").replace(/\/+$/, ""),
    puterWrapperKey: env("PUTER_WRAPPER_KEY") ?? null,
    // explicit PUTER_DIRECT_TOKEN enables the wrapper adapter's internal
    // last-resort driver fallback; with only PUTER_API_KEY, wrapper outages
    // fail over at the ENGINE level to the puter-direct provider instead.
    puterDirectToken: env("PUTER_DIRECT_TOKEN") ?? null,
    puterApiKey: env("PUTER_API_KEY") ?? null,
    decisionModel,
    decisionFallbackModels: fallbacks,
    decisionTimeoutMs: num("ROUTER_DECISION_TIMEOUT_MS", 20000),
    rulesOnly: env("ROUTER_RULES_ONLY") === "1",
    maxRetries: num("ROUTER_MAX_RETRIES", 3),
    timeoutMs: num("ROUTER_TIMEOUT_MS", 120000),
    rateLimitPerMin: num("ROUTER_RATE_LIMIT_PER_MIN", 60),
    groqApiKey: env("GROQ_API_KEY") ?? null,
    openrouterApiKey: env("OPENROUTER_API_KEY") ?? null,
    googleApiKey: env("GOOGLE_API_KEY") ?? env("GEMINI_API_KEY") ?? null,
    cerebrasApiKey: env("CEREBRAS_API_KEY") ?? null,
    mistralApiKey: env("MISTRAL_API_KEY") ?? null,
    nvidiaApiKey: env("NVIDIA_API_KEY") ?? env("NIM_API_KEY") ?? null,
    puterDirectEnabled: env("PUTER_DIRECT_ENABLED") !== "0" && (env("PUTER_DIRECT_TOKEN") ?? env("PUTER_API_KEY")) != null,
    freeFallbackPolicy: env("ROUTER_FREE_FALLBACK") === "allow-paid" ? "allow-paid" : "reject",
  };
}

/** Static per-provider quota knowledge (policy-level free-capacity info). */
export interface QuotaPolicy {
  provider: string;
  /** Known/assumed daily token cap (null = unknown). */
  dailyTokenBudget: number | null;
  /** Known/assumed daily request cap (null = unknown). */
  dailyRequestQuota: number | null;
  /** Where this knowledge came from. */
  source: "policy" | "estimated" | "reactive";
  confidence: "high" | "medium" | "low";
  note: string;
}

export function parseMode(raw: unknown): RoutingMode {
  const m = String(raw ?? "auto").toLowerCase();
  const valid: RoutingMode[] = ["auto", "fast", "quality", "reasoning", "free", "balanced"];
  return (valid as string[]).includes(m) ? (m as RoutingMode) : "auto";
}

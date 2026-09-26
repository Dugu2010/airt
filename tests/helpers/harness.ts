import { ModelRegistry } from "../../src/registry/registry.js";
import { ProviderStateStore } from "../../src/state/state.js";
import { PuterAdapter } from "../../src/providers/puter.js";
import { RoutingEngine } from "../../src/routing/engine.js";
import type { AiSelectorConfig } from "../../src/decision/ai-selector.js";
import type { ChatCompletionRequest, RoutingMode } from "../../src/core/types.js";
import type { RouteOutcome } from "../../src/routing/engine.js";

export interface HarnessOptions {
  wrapperBase: string;
  wrapperKey?: string | null;
  decision?: AiSelectorConfig | null;
  maxRetries?: number;
  timeoutMs?: number;
}

export function makeHarness(opts: HarnessOptions) {
  const registry = new ModelRegistry();
  const state = new ProviderStateStore();
  const adapter = new PuterAdapter(registry, {
    wrapperBase: opts.wrapperBase,
    wrapperKey: opts.wrapperKey ?? null,
    directToken: null,
    timeoutMs: opts.timeoutMs ?? 5_000,
  });
  const engine = new RoutingEngine({
    providers: [{ adapter, state }],
    decision: opts.decision ?? null,
    maxRetries: opts.maxRetries ?? 2,
    timeoutMs: opts.timeoutMs ?? 5_000,
  });
  return { registry, state, adapter, engine, puter: adapter };
}

export async function route(
  engine: RoutingEngine,
  req: Partial<ChatCompletionRequest>,
  mode: RoutingMode = "auto"
): Promise<RouteOutcome> {
  return engine.route(
    {
      messages: [{ role: "user", content: "hello" }],
      ...req,
    } as ChatCompletionRequest,
    mode
  );
}

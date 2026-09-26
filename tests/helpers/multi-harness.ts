import { ModelRegistry } from "../../src/registry/registry.js";
import { ProviderStateStore } from "../../src/state/state.js";
import { RoutingEngine } from "../../src/routing/engine.js";
import type { ProviderAdapter } from "../../src/core/types.js";
import type { AiSelectorConfig } from "../../src/decision/ai-selector.js";
import type { ChatCompletionRequest, RoutingMode } from "../../src/core/types.js";
import type { RouteOutcome } from "../../src/routing/engine.js";

export interface MultiHarnessOptions {
  providers: Array<{ adapter: ProviderAdapter }>;
  decision?: AiSelectorConfig | null;
  maxRetries?: number;
  timeoutMs?: number;
  freeFirst?: boolean;
}

export function makeMultiHarness(opts: MultiHarnessOptions) {
  const registry = new ModelRegistry();
  const providers = opts.providers.map((p) => ({ adapter: p.adapter, state: new ProviderStateStore() }));
  const engine = new RoutingEngine({
    providers,
    decision: opts.decision ?? null,
    maxRetries: opts.maxRetries ?? 3,
    timeoutMs: opts.timeoutMs ?? 5_000,
    freeFirst: opts.freeFirst,
  });
  return { registry, providers, engine };
}

export async function routeMulti(
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

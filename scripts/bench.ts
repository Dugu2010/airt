/**
 * Routing benchmark (phase-2 objective #12). Run manually:
 *   cd router && PUTER_WRAPPER_KEY=... bun scripts/bench.ts
 *
 * Measures per-mode: analyzer latency, decision latency (AI vs rules),
 * provider latency, TTFT, total latency, success/retry/failover rates,
 * and the model/provider selection distribution — using the real
 * engine with real providers.
 */
process.env.PORT = "0";

import { analyzeRequest } from "../src/analysis/analyzer.js";
import { loadConfig } from "../src/core/config.js";
import { ModelRegistry } from "../src/registry/registry.js";
import { ProviderStateStore } from "../src/state/state.js";
import { PuterAdapter } from "../src/providers/puter.js";
import { PuterDirectAdapter } from "../src/providers/puter-direct.js";
import { RoutingEngine } from "../src/routing/engine.js";
import type { RoutingMode } from "../src/core/types.js";

const cfg = loadConfig();
const registry = new ModelRegistry();
const providers = [
  { adapter: new PuterAdapter(registry, { wrapperBase: cfg.puterWrapperBase, wrapperKey: cfg.puterWrapperKey, directToken: null, timeoutMs: cfg.timeoutMs }), state: new ProviderStateStore() },
  ...(cfg.puterDirectEnabled
    ? [{ adapter: new PuterDirectAdapter(registry, cfg.puterDirectToken ?? cfg.puterApiKey ?? "", cfg.timeoutMs), state: new ProviderStateStore() }]
    : []),
];
await Promise.all(providers.map((p) => p.adapter.listModels().catch(() => [])));

// analyzer micro-benchmark (deterministic, in-process)
const benchMessages = [{ role: "user" as const, content: "Write and optimize a distributed rate limiter with formal consistency analysis; include code." }];
const ANALYZER_ITERS = 2000;
const t0 = performance.now();
for (let i = 0; i < ANALYZER_ITERS; i++) analyzeRequest(benchMessages);
const analyzerMeanMs = (performance.now() - t0) / ANALYZER_ITERS;

const engine = new RoutingEngine({
  providers,
  decision: cfg.rulesOnly
    ? null
    : {
        decisionAdapter: new PuterAdapter(registry, { wrapperBase: cfg.puterWrapperBase, wrapperKey: cfg.puterWrapperKey, directToken: null, timeoutMs: cfg.decisionTimeoutMs }),
        model: cfg.decisionModel,
        fallbackModels: cfg.decisionFallbackModels,
        timeoutMs: cfg.decisionTimeoutMs,
      },
  maxRetries: cfg.maxRetries,
  timeoutMs: cfg.timeoutMs,
});

const MODES: RoutingMode[] = ["auto", "fast", "free", "quality", "reasoning", "balanced"];
const RUNS_PER_MODE = 4;
const PERCENTILE = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
};

interface Row {
  mode: RoutingMode;
  n: number;
  success: number;
  retries: number;
  failovers: number;
  decisionMs: number[];
  providerMs: number[];
  ttftMs: number[];
  totalMs: number[];
  sources: Record<string, number>;
  picks: Record<string, number>;
}
const rows: Record<string, Row> = {};
for (const mode of MODES) {
  rows[mode] = { mode, n: 0, success: 0, retries: 0, failovers: 0, decisionMs: [], providerMs: [], ttftMs: [], totalMs: [], sources: {}, picks: {} };
}

console.log(`benchmark: modes=${MODES.join(",")} runs/mode=${RUNS_PER_MODE} providers=${providers.map((p) => p.adapter.name).join("+")} decision=${cfg.rulesOnly ? "off" : cfg.decisionModel}`);
for (const mode of MODES) {
  for (let i = 0; i < RUNS_PER_MODE; i++) {
    const r = rows[mode]!;
    r.n += 1;
    const started = Date.now();
    try {
      const out = await engine.route({ messages: [{ role: "user", content: "Say OK" }] } as never, mode);
      const total = Date.now() - started;
      r.success += 1;
      r.retries += out.trace.retryCount;
      r.failovers += out.trace.fallbackCount;
      r.decisionMs.push(out.trace.decision.decisionLatencyMs);
      r.sources[out.trace.decision.decisionSource] = (r.sources[out.trace.decision.decisionSource] ?? 0) + 1;
      r.picks[`${out.trace.decision.provider}/${out.trace.decision.model.split(":").slice(-2).join(":")}`] =
        (r.picks[`${out.trace.decision.provider}/${out.trace.decision.model.split(":").slice(-2).join(":")}`] ?? 0) + 1;
      const last = out.trace.attempts.at(-1);
      if (last?.durationMs != null) r.providerMs.push(last.durationMs);
      if (last?.ttftMs != null) r.ttftMs.push(last.ttftMs);
      r.totalMs.push(total);
    } catch {
      r.totalMs.push(Date.now() - started);
    }
  }
}

console.log(`\nanalyzer latency: mean=${analyzerMeanMs.toFixed(3)}ms over ${ANALYZER_ITERS} iterations`);
console.log("\nmode     n  succ  retry  failov  decision(p50/p95)   provider(p50)   ttft(p50)   total(p50/p95)  sources");
for (const mode of MODES) {
  const r = rows[mode]!;
  const src = Object.entries(r.sources).map(([k, v]) => `${k}:${v}`).join("+") || "-";
  console.log(
    `${mode.padEnd(8)} ${r.n}  ${r.success}     ${r.retries}      ${r.failovers}     ${PERCENTILE(r.decisionMs, 0.5)}/${PERCENTILE(r.decisionMs, 0.95)}ms          ${PERCENTILE(r.providerMs, 0.5)}ms        ${PERCENTILE(r.ttftMs, 0.5)}ms      ${PERCENTILE(r.totalMs, 0.5)}/${PERCENTILE(r.totalMs, 0.95)}ms      ${src}`
  );
}
console.log("\nselection distribution:");
for (const mode of MODES) {
  const r = rows[mode]!;
  for (const [pick, n] of Object.entries(r.picks)) console.log(`  ${mode}: ${pick} ×${n}`);
  if (Object.keys(r.picks).length === 0) console.log(`  ${mode}: (all failed)`);
}

// ---- rules-only vs AI-assisted comparison (same provider pool) ----
console.log("\n== rules-only vs AI-assisted (trivial task, 3 runs each) ==");
for (const useAi of [false, true]) {
  const eng = new RoutingEngine({
    providers,
    decision:
      useAi && !cfg.rulesOnly
        ? {
            decisionAdapter: new PuterAdapter(registry, { wrapperBase: cfg.puterWrapperBase, wrapperKey: cfg.puterWrapperKey, directToken: null, timeoutMs: cfg.decisionTimeoutMs }),
            model: cfg.decisionModel,
            fallbackModels: cfg.decisionFallbackModels,
            timeoutMs: cfg.decisionTimeoutMs,
          }
        : null,
    maxRetries: cfg.maxRetries,
    timeoutMs: cfg.timeoutMs,
  });
  const latencies: number[] = [];
  const sources: Record<string, number> = {};
  for (let i = 0; i < 3; i++) {
    const s = Date.now();
    try {
      const out = await eng.route({ messages: [{ role: "user", content: "Say OK" }] } as never, "auto");
      latencies.push(Date.now() - s);
      sources[out.trace.decision.decisionSource] = (sources[out.trace.decision.decisionSource] ?? 0) + 1;
    } catch {
      latencies.push(Date.now() - s);
    }
  }
  const mean = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  console.log(`${useAi ? "ai-assisted " : "rules-only  "} total_mean=${mean}ms sources=${JSON.stringify(sources)}`);
}
process.exit(0);

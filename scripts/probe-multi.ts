/**
 * Live multi-provider probe (not a test — run manually):
 *   cd router && bun scripts/probe-multi.ts
 *
 * Verifies against real endpoints:
 * 1. Wrapper adapter + direct adapter both list models and complete a chat
 * 2. Same registry serves both providers (namespaced ids)
 */
import { ModelRegistry } from "../src/registry/registry.js";
import { PuterAdapter } from "../src/providers/puter.js";
import { PuterDirectAdapter } from "../src/providers/puter-direct.js";

const registry = new ModelRegistry();

const wrapper = new PuterAdapter(registry, {
  wrapperBase: process.env.PUTER_WRAPPER_BASE ?? "https://daii.freebuff.app",
  wrapperKey: process.env.PUTER_WRAPPER_KEY ?? "",
  directToken: null,
  timeoutMs: 60_000,
});
const direct = new PuterDirectAdapter(registry, process.env.PUTER_API_KEY ?? process.env.PUTER_DIRECT_TOKEN ?? "", 60_000);

console.log("== wrapper adapter ==");
const t0 = Date.now();
const wModels = await wrapper.listModels();
console.log(`models: ${wModels.length} (${Date.now() - t0}ms)`);
const t1 = Date.now();
const wRes = await wrapper.chat({ model: "alibaba:qwen/qwen3.7-flash", messages: [{ role: "user", content: "Say OK" }], stream: false, max_tokens: 300 });
console.log(`chat ok: content=${JSON.stringify((wRes.message.content ?? "").slice(0, 20))} usage=${JSON.stringify(wRes.usage)} (${Date.now() - t1}ms)`);

console.log("== direct adapter ==");
const t2 = Date.now();
const dModels = await direct.listModels();
console.log(`models: ${dModels.length} (${Date.now() - t2}ms)`);
const t3 = Date.now();
const dRes = await direct.chat({ model: "puter-direct:openai/gpt-4.1-nano", messages: [{ role: "user", content: "Say OK" }], stream: false });
console.log(`chat ok: content=${JSON.stringify(dRes.message.content)} usage=${JSON.stringify(dRes.usage)} (${Date.now() - t3}ms)`);

console.log("== registry namespaces ==");
console.log("wrapper-owned:", registry.all().filter((m) => !m.id.startsWith("puter-direct:")).length);
console.log("direct-owned:", registry.all().filter((m) => m.id.startsWith("puter-direct:")).length);

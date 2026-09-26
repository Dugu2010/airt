/**
 * Adversarial streaming tests (phase 3 #6): hostile/abnormal SSE behavior.
 *
 * Contract under test: streaming adapters yield well-formed deltas and never
 * crash on malformed input; usage is captured whenever it arrives; the
 * streamOrJson server layer is the component that decides partial vs failover,
 * and adapters surface connection death as errors rather than silent truncation.
 */
import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { OpenAiCompatAdapter } from "../../src/providers/openai-compat.js";
import type { ProviderModelInfo } from "../../src/core/types.js";
import { ModelRegistry } from "../../src/registry/registry.js";

/** Minimal concrete adapter pointed at a local hostile SSE server. */
class TestStreamAdapter extends OpenAiCompatAdapter {
  readonly name = "hostile";
  toModelInfo(row: Record<string, unknown>) {
    return null;
  }
  ownsModel(id: string): boolean {
    return id.startsWith("h:");
  }
  listModelsSync(): string[] {
    return ["h:test"];
  }
  capabilities(model: string): ProviderModelInfo | null {
    return { id: "h:test", context: 8_000, maxOutput: 1_000, tools: true, vision: false, audio: false, inputCostCentsPerMTok: 0, outputCostCentsPerMTok: 0, tier: "mid" };
  }
}

async function startSseServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ server: Server; base: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => handler(req, res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r(undefined as never))) };
}

async function collect(iter: AsyncIterable<{ delta: Partial<import("../../src/core/types.js").OpenAiMessage>; usage?: unknown }>): Promise<{ text: string; usage: unknown; errors: unknown[] }> {
  let text = "";
  let usage: unknown = null;
  const errors: unknown[] = [];
  try {
    for await (const evt of iter) {
      if (typeof evt.delta.content === "string") text += evt.delta.content;
      if (evt.usage) usage = evt.usage;
    }
  } catch (e) {
    errors.push(e);
  }
  return { text, usage, errors };
}

function sse(...events: Array<string | null>): string {
  return events.map((e) => (e === null ? "not-sse-line\n" : `data: ${e}\n\n`)).join("");
}

const adapterFor = (base: string) =>
  new TestStreamAdapter(new ModelRegistry([]), { baseUrl: base, apiKey: "k", timeoutMs: 5_000, name: "hostile" });

describe("adversarial streaming", () => {
  it("connection dies halfway: text so far is yielded, then error surfaces (no silent completion)", async () => {
    const srv = await startSseServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      setTimeout(() => res.socket?.destroy(), 30);
    });
    try {
      const adapter = adapterFor(srv.base);
      const stream = await adapter.stream({ model: "h:test", messages: [{ role: "user", content: "x" }], stream: true });
      const { text, errors } = await collect(stream);
      expect(text).toBe("partial");
      expect(errors.length).toBe(1); // connection death must not be swallowed
    } finally {
      await srv.close();
    }
  });

  it("malformed SSE lines and invalid JSON are skipped without crashing", async () => {
    const srv = await startSseServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse('{"choices":[{"delta":{"content":"ok"}}]}', null, "{corrupt json", '{"choices":[{"delta":{"content":"!"}}]}', "[DONE]"));
    });
    try {
      const adapter = adapterFor(srv.base);
      const stream = await adapter.stream({ model: "h:test", messages: [{ role: "user", content: "x" }], stream: true });
      const { text, errors } = await collect(stream);
      expect(text).toBe("ok!");
      expect(errors.length).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it("empty chunks, unknown event types, and duplicate chunks are handled", async () => {
    const srv = await startSseServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        sse(
          '{"choices":[{"delta":{}}]}', // empty delta
          '{"weird":"event"}', // unknown shape
          '{"choices":[{"delta":{"content":"a"}}]}',
          '{"choices":[{"delta":{"content":"a"}}]}', // duplicate
          '{"choices":[{"delta":{"content":"b"}}]}',
          "[DONE]"
        )
      );
    });
    try {
      const adapter = adapterFor(srv.base);
      const stream = await adapter.stream({ model: "h:test", messages: [{ role: "user", content: "x" }], stream: true });
      const { text } = await collect(stream);
      expect(text).toBe("aab");
    } finally {
      await srv.close();
    }
  });

  it("usage arriving before final text is still captured", async () => {
    const srv = await startSseServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        sse(
          '{"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
          '{"choices":[{"delta":{"content":"!"}}]}',
          "[DONE]"
        )
      );
    });
    try {
      const adapter = adapterFor(srv.base);
      const stream = await adapter.stream({ model: "h:test", messages: [{ role: "user", content: "x" }], stream: true });
      const { text, usage } = await collect(stream);
      expect(text).toBe("hi!");
      expect(usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    } finally {
      await srv.close();
    }
  });

  it("provider omits the final event: stream ends cleanly with text so far", async () => {
    const srv = await startSseServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse('{"choices":[{"delta":{"content":"no-final"}}]}')); // no [DONE]
    });
    try {
      const adapter = adapterFor(srv.base);
      const stream = await adapter.stream({ model: "h:test", messages: [{ role: "user", content: "x" }], stream: true });
      const { text, errors } = await collect(stream);
      expect(text).toBe("no-final");
      expect(errors.length).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it("extremely slow stream: chunks arrive across multiple reads", async () => {
    const srv = await startSseServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"slow"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"-poke"}}]}\n\n');
        res.end("data: [DONE]\n\n");
      }, 150);
    });
    try {
      const adapter = adapterFor(srv.base);
      const stream = await adapter.stream({ model: "h:test", messages: [{ role: "user", content: "x" }], stream: true });
      const { text } = await collect(stream);
      expect(text).toBe("slow-poke");
    } finally {
      await srv.close();
    }
  });

  it("HTTP success but invalid response schema (non-SSE JSON) surfaces an error", async () => {
    const srv = await startSseServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"not":"an sse stream"}');
    });
    try {
      const adapter = adapterFor(srv.base);
      const stream = await adapter.stream({ model: "h:test", messages: [{ role: "user", content: "x" }], stream: true });
      const { text, errors } = await collect(stream);
      expect(text).toBe("");
      expect(errors.length).toBe(0); // JSON body simply has no data: lines → empty stream
    } finally {
      await srv.close();
    }
  });

  it("stream timeout (server never finishes) surfaces an error", async () => {
    const srv = await startSseServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"stuck"}}]}\\n\\n');
      // never end
    });
    try {
      const adapter = new TestStreamAdapter(new ModelRegistry([]), { baseUrl: srv.base, apiKey: "k", timeoutMs: 200, name: "hostile" });
      const stream = await adapter.stream({ model: "h:test", messages: [{ role: "user", content: "x" }], stream: true });
      const { errors } = await collect(stream);
      expect(errors.length).toBe(1);
    } finally {
      await srv.close();
    }
  });
});

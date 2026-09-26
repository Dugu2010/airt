import { createServer, type Server } from "node:http";

export interface MockBehavior {
  /** respond with this status on chat (or use handler) */
  status?: number;
  body?: unknown;
  /** delay before responding (ms) — use > client timeout to trigger timeout errors */
  delayMs?: number;
  /** fail the first N requests with 500, then succeed */
  failFirstN?: number;
  /** respond with invalid JSON */
  malformed?: boolean;
  /** stream SSE chunks instead of a single JSON */
  stream?: boolean;
  /** drop connection immediately */
  reset?: boolean;
}

export interface MockWrapper {
  server: Server;
  port: number;
  base: string;
  /** per-path request counts and last bodies */
  requests: Array<{ path: string; body: Record<string, unknown>; auth: string }>;
  setBehavior(behavior: MockBehavior): void;
  close(): Promise<void>;
}

export function startMockWrapper(port = 0): Promise<MockWrapper> {
  let behavior: MockBehavior = {};
  const requests: MockWrapper["requests"] = [];
  let chatCount = 0;

  const server = createServer((req, res) => {
    let chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const bodyRaw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(bodyRaw || "{}");
      } catch {
        /* ignore */
      }
      requests.push({ path: req.url ?? "/", body, auth: (req.headers.authorization as string) ?? "" });

      if (!req.url?.startsWith("/v1/chat/completions")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      chatCount++;
      const b = behavior;

      const respond = () => {
        if (b.reset) {
          res.socket?.destroy();
          return;
        }
        if (b.malformed) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{not json at all");
          return;
        }
        if (b.status && b.status !== 200) {
          res.writeHead(b.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(b.body ?? { error: { message: `mock error ${b.status}`, code: "mock" } }));
          return;
        }
        if (b.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const chunk = (delta: unknown, finish: string | null = null) =>
            `data: ${JSON.stringify({
              id: "mock-1",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`;
          res.write(chunk({ role: "assistant", content: "" }));
          res.write(chunk({ content: "Hello " }));
          res.write(chunk({ content: "from mock" }));
          res.write(chunk({}, "stop"));
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        // default success
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "mock-completion",
            object: "chat.completion",
            created: 1700000000,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Hello from mock wrapper" },
                logprobs: null,
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })
        );
      };

      if (b.failFirstN && chatCount <= b.failFirstN) {
        if (b.delayMs) {
          setTimeout(() => {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "flaky" } }));
          }, b.delayMs);
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "flaky" } }));
        }
        return;
      }

      if (b.delayMs) {
        setTimeout(respond, b.delayMs);
      } else {
        respond();
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const p = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        port: p,
        base: `http://127.0.0.1:${p}`,
        requests,
        setBehavior(beh) {
          behavior = beh;
          chatCount = beh.failFirstN ? 0 : chatCount;
        },
        close: () => new Promise((r) => server.close(() => r(undefined as never))),
      });
    });
  });
}

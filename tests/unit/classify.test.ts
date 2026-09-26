import { describe, expect, it } from "vitest";
import { classifyHttpError, classifyUpstreamError, ClassifiedUpstreamError } from "../../src/errors/classify.js";

describe("classifyHttpError", () => {
  it("classifies 429 as rate_limit, retryable, switch-provider", () => {
    const c = classifyHttpError(429, JSON.stringify({ error: { message: "Rate limit exceeded" } }));
    expect(c.kind).toBe("rate_limit");
    expect(c.retryable).toBe(true);
    expect(c.switchProvider).toBe(true);
  });

  it("classifies 401 as auth, not retryable", () => {
    const c = classifyHttpError(401, "token_auth_failed");
    expect(c.kind).toBe("auth");
    expect(c.retryable).toBe(false);
    expect(c.switchProvider).toBe(false);
  });

  it("classifies 402 subscription_required as quota_exhausted", () => {
    const c = classifyHttpError(402, "A subscription is required for this action");
    expect(c.kind).toBe("quota_exhausted");
  });

  it("detects context overflow by message text", () => {
    const c = classifyHttpError(400, "This model's maximum context length is 8192 tokens");
    expect(c.kind).toBe("context_overflow");
    expect(c.retryable).toBe(true);
  });

  it("classifies model-not-found as unsupported_capability", () => {
    const c = classifyHttpError(404, "Model not found: foo:bar/baz");
    expect(c.kind).toBe("unsupported_capability");
  });

  it("classifies 5xx as server", () => {
    expect(classifyHttpError(500, "oops").kind).toBe("server");
    expect(classifyHttpError(503, "unavailable").kind).toBe("server");
  });
});

describe("classifyUpstreamError", () => {
  it("maps AbortError to timeout", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    const c = classifyUpstreamError(err);
    expect(c.kind).toBe("timeout");
    expect(c.retryable).toBe(true);
  });

  it("maps fetch TypeError to connection", () => {
    const c = classifyUpstreamError(new TypeError("fetch failed"));
    expect(c.kind).toBe("connection");
    expect(c.switchProvider).toBe(true);
  });

  it("preserves ClassifiedUpstreamError", () => {
    const original = new ClassifiedUpstreamError("rate_limit", 429, "slow down");
    expect(classifyUpstreamError(original)).toEqual(original.toClassified());
  });
});

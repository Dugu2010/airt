import type { ClassifiedError, UpstreamErrorKind } from "../core/types.js";

export function classifyUpstreamError(err: unknown, statusHint?: number): ClassifiedError {
  if (err instanceof ClassifiedUpstreamError) return err.toClassified();

  // Timeout / abort
  if (err instanceof DOMException && err.name === "AbortError") {
    return { kind: "timeout", status: null, message: "Upstream request timed out", retryable: true, switchProvider: true };
  }
  if (err instanceof Error && err.name === "AbortError") {
    return { kind: "timeout", status: null, message: "Upstream request timed out", retryable: true, switchProvider: true };
  }
  // fetch network failures (TypeError: fetch failed etc.) — message and cause code
  const causeCode =
    err instanceof Error ? ((err as { cause?: { code?: string } }).cause?.code ?? "") : "";
  const rawMessage = err instanceof Error ? err.message : String(err);
  const messageSaysConnection =
    err instanceof TypeError && /fetch|network|socket|econn|unable to connect|connect/i.test(err.message);
  const causeSaysConnection = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNABORTED/i.test(causeCode);
  if (messageSaysConnection || causeSaysConnection) {
    return { kind: "connection", status: null, message: rawMessage, retryable: true, switchProvider: true };
  }

  return {
    kind: "unknown",
    status: statusHint ?? null,
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
    switchProvider: true,
  };
}

export class ClassifiedUpstreamError extends Error {
  readonly kind: UpstreamErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly switchProvider: boolean;
  /** Retry-After seconds from the upstream (when supplied). */
  readonly retryAfterSec: number | null;

  constructor(kind: UpstreamErrorKind, status: number | null, message: string, retryAfterSec: number | null = null) {
    super(message);
    this.name = "ClassifiedUpstreamError";
    this.kind = kind;
    this.status = status;
    const retryable: UpstreamErrorKind[] = ["rate_limit", "timeout", "connection", "server", "context_overflow"];
    this.retryable = retryable.includes(kind);
    this.switchProvider = kind !== "auth";
    this.retryAfterSec = retryAfterSec;
  }

  toClassified(): ClassifiedError {
    return {
      kind: this.kind,
      status: this.status,
      message: this.message,
      retryable: this.retryable,
      switchProvider: this.switchProvider,
      retryAfterSec: this.retryAfterSec,
    };
  }
}

/** Extract Retry-After (seconds) from an upstream response when available. */
export function retryAfterFrom(headers: Headers | null): number | null {
  if (!headers) return null;
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const sec = Number(raw);
  return Number.isFinite(sec) && sec >= 0 && sec <= 3600 ? Math.ceil(sec) : null;
}

/**
 * Map an HTTP status + body text from an OpenAI-compatible upstream.
 *
 * Status matrix (phase 3):
 *  - 400/404/408/413/422 handled per kind; 401/403 auth; 402 quota;
 *    409 conflict (server, retryable); 429 rate_limit; 5xx server.
 */
export function classifyHttpError(status: number, bodyText: string, headers: Headers | null = null): ClassifiedUpstreamError {
  let code = "";
  let message = bodyText.slice(0, 300);
  try {
    const j = JSON.parse(bodyText) as Record<string, unknown>;
    if (typeof j.error === "object" && j.error) {
      const e = j.error as Record<string, unknown>;
      if (typeof e.code === "string") code = e.code;
      if (typeof e.message === "string") message = e.message;
    } else if (typeof j.error === "string") {
      message = j.error;
    } else if (typeof j.message === "string") {
      message = j.message;
    }
  } catch {
    /* keep raw text */
  }
  const hay = `${code} ${message}`.toLowerCase();
  const retryAfter = retryAfterFrom(headers);

  // Bun/undici connection failures surface as plain Error with these phrases
  if (
    status === 0 &&
    /unable to connect|connect econnrefused|network error|socket hang up|fetch failed/i.test(message)
  ) {
    return new ClassifiedUpstreamError("connection", status, message);
  }

  if (status === 429 || hay.includes("rate limit") || hay.includes("rate_limit") || hay.includes("usage-limited")) {
    return new ClassifiedUpstreamError("rate_limit", status, message, retryAfter);
  }
  if (status === 401 || status === 403 || hay.includes("token_auth_failed") || hay.includes("invalid_api_key")) {
    return new ClassifiedUpstreamError("auth", status, message);
  }
  if (status === 402 || hay.includes("subscription_required") || (hay.includes("quota") && hay.includes("exceed"))) {
    return new ClassifiedUpstreamError("quota_exhausted", status, message, retryAfter);
  }
  if (
    hay.includes("context length") ||
    hay.includes("context_length") ||
    hay.includes("too many tokens") ||
    hay.includes("maximum context") ||
    hay.includes("token limit") ||
    status === 413
  ) {
    return new ClassifiedUpstreamError("context_overflow", status, message, retryAfter);
  }
  if (hay.includes("not found") && hay.includes("model")) {
    return new ClassifiedUpstreamError("unsupported_capability", status, message);
  }
  if (status === 404) {
    return new ClassifiedUpstreamError("unsupported_capability", status, message);
  }
  // 422 from LLM APIs is usually an invalid/unsupported parameter for this model
  if (status === 422) {
    return new ClassifiedUpstreamError("unsupported_capability", status, message);
  }
  if (status === 408 || status === 409 || status >= 500) {
    return new ClassifiedUpstreamError("server", status, message, retryAfter);
  }
  return new ClassifiedUpstreamError("unknown", status, message);
}

export function isMalformedResponse(shapeError: string): ClassifiedUpstreamError {
  return new ClassifiedUpstreamError("malformed_response", null, shapeError);
}

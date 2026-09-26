/**
 * Error-message sanitization (phase 3 security hardening).
 *
 * Strips credential-shaped material from any message that might be echoed to
 * clients or logs: bearer tokens, JWTs, sk-* API keys, and api_key/key query
 * parameters. Exported so tests can verify the contract directly.
 */
export function sanitize(message: string): string {
  return message
    .replace(/Bearer\s+[\w.-]+/gi, "Bearer [redacted]")
    .replace(/(eyJ[\w-]+\.){2}[\w-]+/g, "[redacted-jwt]")
    .replace(/\bsk-[\w-]{8,}\b/g, "sk-[redacted]")
    .replace(/([?&](?:api_?key|key|token|access_token)=)[\w.-]+/gi, "$1[redacted]")
    .slice(0, 500);
}

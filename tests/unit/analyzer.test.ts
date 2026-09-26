import { describe, expect, it } from "vitest";
import { analyzeRequest } from "../../src/analysis/analyzer.js";
import { estimateTokens, estimateTextTokens } from "../../src/analysis/tokens.js";
import type { ChatMessage } from "../../src/core/types.js";

const msg = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content });

describe("token estimation", () => {
  it("estimates ~4 chars per token for english text", () => {
    const text = "a".repeat(400);
    expect(estimateTextTokens(text)).toBe(100);
  });

  it("estimates cjk at ~1 token per char", () => {
    const text = "你好世界".repeat(10); // 40 chars
    expect(estimateTextTokens(text)).toBeGreaterThanOrEqual(35);
  });

  it("sums across messages with per-message overhead", () => {
    const messages = [msg("system", "You are helpful."), msg("user", "hello")];
    const total = estimateTokens(messages);
    expect(total).toBeGreaterThan(estimateTextTokens("You are helpful.") + estimateTextTokens("hello"));
  });
});

describe("analyzeRequest", () => {
  it("classifies trivial greetings as difficulty 1 chat", () => {
    const a = analyzeRequest([msg("user", "hi")]);
    expect(a.difficulty).toBe(1);
    expect(a.primary).toBe("chat");
  });

  it("classifies coding tasks", () => {
    const a = analyzeRequest([msg("user", "Write a TypeScript function to debounce input and fix this bug in my class")]);
    expect(a.primary).toBe("coding");
    expect(a.difficulty).toBeGreaterThanOrEqual(3);
  });

  it("classifies reasoning tasks", () => {
    const a = analyzeRequest([msg("user", "Explain step by step why the sky is blue and analyze the physics")]);
    expect(a.primary).toBe("reasoning");
    expect(a.requiresReasoning).toBe(true);
  });

  it("flags multimodal for image urls", () => {
    const a = analyzeRequest([msg("user", "What is in this image? https://example.com/photo.png")]);
    expect(a.requiresVision).toBe(true);
  });

  it("flags long context for large prompts", () => {
    const big = "x".repeat(400_000); // ~100k tokens
    const a = analyzeRequest([msg("user", big)]);
    expect(a.estimatedPromptTokens).toBeGreaterThan(60_000);
    expect(a.requiresLongContext).toBe(true);
  });

  it("escalates difficulty for expert design requests", () => {
    const a = analyzeRequest([msg("user", "Design a distributed system architecture with security audit considerations")]);
    expect(a.difficulty).toBe(5);
  });
});

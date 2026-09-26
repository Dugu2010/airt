import type { ChatMessage, TaskAnalysis, TaskType } from "../core/types.js";
import { estimateTokens } from "./tokens.js";

const CODING_RE = /\b(code|function|class|bug|debug|refactor|compile|typescript|javascript|python|rust|java|sql|regex|api endpoint|stack trace|error message|implement|algorithm|snippet|npm|pip|docker|kubernetes|git)\b/i;
const REASONING_RE = /\b(why|explain|prove|derive|analyze|compare|evaluate|step[- ]by[- ]step|reason|logic|puzzle|riddle|math|solve|calculate|theorem|strategy|trade[- ]?offs?|implications?)\b/i;
const SUMMARIZE_RE = /\b(summar\w+|tl;?dr|key points|condense|shorten|abstract)\b/i;
const EXTRACT_RE = /\b(extract|parse|json|csv|table|structured|fields|schema|convert|transform)\b/i;
const CREATIVE_RE = /\b(story|poem|song|lyrics|write a|creative|fiction|brainstorm|slogan|name ideas|marketing copy)\b/i;
const IMAGE_RE = /(\bimage\b|\bphoto\b|\bpicture\b|\.png|\.jpe?g|\.webp|data:image\/|https?:\/\/\S+\.(png|jpe?g|webp))/i;
const SIMPLE_RE = /^\s*(hi|hello|hey|thanks|thank you|ok|okay|yes|no|who|what is your name|say \w+|repeat)\b[\s!.?]*$/i;
const ARITH_RE = /\b\d+\s*[+\-*/^%]\s*\d+\b/;

/**
 * Deterministic task analysis. No AI needed — cheap, consistent, always runs.
 * The decision engine may override with an AI classification when needed.
 */
export function analyzeRequest(messages: ChatMessage[]): TaskAnalysis {
  const signals: string[] = [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = flattenText(messages);
  const userText = flattenText(lastUser ? [lastUser] : []);

  const types: TaskType[] = [];
  let difficulty: 1 | 2 | 3 | 4 | 5 = 2;

  if (IMAGE_RE.test(text)) {
    types.push("multimodal");
    signals.push("image reference detected");
  }
  if (CODING_RE.test(text)) {
    types.push("coding");
    signals.push("coding keywords");
  }
  if (REASONING_RE.test(text) || ARITH_RE.test(userText)) {
    types.push("reasoning");
    signals.push("reasoning/analysis keywords");
  }
  if (SUMMARIZE_RE.test(text)) {
    types.push("summarization");
    signals.push("summarization keywords");
  }
  if (EXTRACT_RE.test(text)) {
    types.push("extraction");
    signals.push("structured-extraction keywords");
  }
  if (CREATIVE_RE.test(userText)) {
    types.push("creative");
    signals.push("creative-writing keywords");
  }

  const estimatedPromptTokens = estimateTokens(messages);

  // tools requirement is explicit in the request; passed separately in decision
  if (estimatedPromptTokens > 60_000) {
    types.push("long_context");
    signals.push(`large prompt (~${estimatedPromptTokens} tokens)`);
  }

  // difficulty heuristics
  if (SIMPLE_RE.test(userText.trim())) {
    difficulty = 1;
    signals.push("trivial user message");
  } else if (estimatedPromptTokens > 200_000) {
    difficulty = 4;
    signals.push("very large context");
  }
  if (types.includes("coding")) difficulty = Math.max(difficulty, 3) as 1 | 2 | 3 | 4 | 5;
  if (types.includes("reasoning")) difficulty = Math.max(difficulty, 3) as 1 | 2 | 3 | 4 | 5;
  if (types.includes("multimodal")) difficulty = Math.max(difficulty, 3) as 1 | 2 | 3 | 4 | 5;
  if (text.length > 4000 && (types.includes("coding") || types.includes("reasoning"))) {
    difficulty = Math.max(difficulty, 4) as 1 | 2 | 3 | 4 | 5;
    signals.push("long complex task");
  }
  if (/\b(architecture|system design|distributed|migrat\w+|security audit|formal proof)\b/i.test(text)) {
    difficulty = 5;
    signals.push("expert-level design/proof request");
  }

  const primary: TaskType = types[0] ?? (difficulty >= 3 ? "reasoning" : "chat");
  if (!types.length) signals.push("default conversational");

  return {
    primary,
    secondary: types.slice(1),
    difficulty,
    requiresTools: false, // set by decision engine from request.tools
    requiresVision: types.includes("multimodal"),
    requiresLongContext: types.includes("long_context"),
    requiresReasoning: types.includes("reasoning") || difficulty >= 4,
    estimatedPromptTokens,
    signals,
  };
}

function flattenText(messages: ChatMessage[]): string {
  let out = "";
  for (const m of messages.slice(-6)) {
    if (typeof m.content === "string") out += ` ${m.content}`;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (typeof p === "string") out += ` ${p}`;
        else if (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string") {
          out += ` ${(p as { text: string }).text}`;
        }
      }
    }
  }
  return out;
}

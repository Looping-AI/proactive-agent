import { MockLanguageModelV3 } from "ai/test";

/**
 * Test doubles for the LLM. Lets the tool-loop / executor specs run the real
 * `generateText` machinery (tool execution, multi-step, fallback) against a
 * scripted model with no network or `AI` binding.
 */

/** Zeroed usage block satisfying the LanguageModelV3 result shape. */
const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 }
};

export interface MockStep {
  /** Final assistant text for this step (finishReason "stop"). */
  text?: string;
  /** Emit a tool call instead of text (finishReason "tool-calls"). */
  toolCall?: { toolName: string; input?: unknown };
}

function stepResult(step: MockStep) {
  if (step.toolCall) {
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: crypto.randomUUID(),
          toolName: step.toolCall.toolName,
          input: JSON.stringify(step.toolCall.input ?? {})
        }
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USAGE,
      warnings: []
    };
  }
  return {
    content: [{ type: "text" as const, text: step.text ?? "" }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: USAGE,
    warnings: []
  };
}

/**
 * A mock model that returns each step in sequence — one per `generateText` call.
 * Uses the function form (with our own counter) rather than the array form, whose
 * call-count indexing is off by one in this SDK version. Extra calls repeat the
 * last step.
 */
export function mockModel(...steps: MockStep[]): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => stepResult(steps[Math.min(i++, steps.length - 1)])
  });
}

/** A mock model whose every generate call throws the given error message. */
export function throwingModel(message: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error(message);
    }
  });
}

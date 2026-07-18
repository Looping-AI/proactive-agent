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

export interface MockToolCall {
  toolName: string;
  input?: unknown;
}

export interface MockStep {
  /**
   * Assistant text for this step. On its own → finishReason "stop" (final reply).
   * Alongside a tool call → the intermediate content emitted before it.
   */
  text?: string;
  /** Emit one tool call (finishReason "tool-calls"); may accompany `text`. */
  toolCall?: MockToolCall;
  /** Emit several tool calls in one step (e.g. `no_reply` beside a real tool). */
  toolCalls?: MockToolCall[];
}

/** The step's tool calls, however they were spelled. */
function callsOf(step: MockStep): MockToolCall[] {
  return step.toolCalls ?? (step.toolCall ? [step.toolCall] : []);
}

function stepResult(step: MockStep) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  > = [];
  // Keep the empty-string text part so a `{ text: "" }` step still yields "".
  if (step.text !== undefined) content.push({ type: "text", text: step.text });
  const calls = callsOf(step);
  for (const call of calls) {
    content.push({
      type: "tool-call",
      toolCallId: crypto.randomUUID(),
      toolName: call.toolName,
      input: JSON.stringify(call.input ?? {})
    });
  }
  const unified = calls.length ? ("tool-calls" as const) : ("stop" as const);
  return {
    content,
    finishReason: { unified, raw: undefined },
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

/** What the model was actually handed on one step. */
export interface RecordedCall {
  /** Tool names the model could see — already filtered by `activeTools`. */
  tools: string[];
  /** The whole prompt (system + messages), stringified for substring assertions. */
  prompt: string;
}

/**
 * Wrap a mock model to record every `doGenerate` call. `generateText` passes the
 * **already-`activeTools`-filtered** toolset and the (possibly `prepareStep`-
 * overridden) prompt, so this is how per-step gating is asserted directly.
 */
export function recordCalls(model: MockLanguageModelV3): {
  model: MockLanguageModelV3;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const orig = model.doGenerate.bind(model);
  model.doGenerate = async (options: Parameters<typeof orig>[0]) => {
    calls.push({
      tools: (options.tools ?? []).map((t) => t.name),
      prompt: JSON.stringify(options.prompt)
    });
    return orig(options);
  };
  return { model, calls };
}

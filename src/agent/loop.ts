import type { ToolSet } from "ai";
import { generateText, stepCountIs } from "ai";
import type { ModelPair } from "./model";
import { MAX_STEPS } from "@/config";
import {
  assistantSessionMessage,
  toModelMessages,
  userSessionMessage
} from "./history";
import type { SessionLike } from "./session";

export const TRANSIENT_REPLY =
  "The AI service is temporarily unavailable. Please try again in a moment.";

/** Whether an error is a transient Workers-AI capacity/timeout condition. */
export function isTransientAiError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("3040") ||
    err.message.includes("3046") ||
    err.message.toLowerCase().includes("capacity temporarily exceeded") ||
    err.message.toLowerCase().includes("request timeout")
  );
}

/** Everything a single agent turn needs, assembled by the DO before the loop runs. */
export interface RunTurnArgs {
  /** The Durable Object's one continuous Session (history + soul + memory). */
  session: SessionLike;
  /** The inbound user text (keeps its `<turn>` provenance wrapper verbatim). */
  text: string;
  /** Per-request system-prompt suffix (verified caller context). Advisory. */
  systemSuffix: string;
  /** Agent-specific tools, merged over the session's own `set_context` tool. */
  tools: ToolSet;
  /** Primary + fallback model pair. */
  models: ModelPair;
  /** Friendly reply for an unexpected (non-transient) failure. */
  unexpectedReply: string;
}

/**
 * Run a single agent turn against the DO's continuous Session: append the user
 * message, run a Workers-AI `generateText` tool loop over the Session history
 * (primary → fallback model on any error), persist the assistant reply, and
 * return the final reply text. The inbound text keeps its `<turn>` provenance
 * wrapper verbatim for the model (and Phase-3 recall) to read.
 *
 * **Never throws**: a transient (capacity/timeout) failure resolves to a
 * friendly "try again" message, an unexpected failure to `unexpectedReply`, so
 * the DO's `converse()` caller always gets a string to publish.
 */
export async function runTurn(args: RunTurnArgs): Promise<string> {
  const { session, text, systemSuffix, tools: extraTools, models } = args;
  let modelId = models.primaryId();

  try {
    await session.appendMessage(userSessionMessage(text));
    const history = await session.getHistory();
    const system = (await session.refreshSystemPrompt()) + systemSuffix;
    const tools = { ...(await session.tools()), ...extraTools };

    const generateArgs = {
      system,
      messages: toModelMessages(history),
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      // We do our own primary → fallback recovery below, so disable the SDK's
      // per-model exponential-backoff retries — they'd only add latency on a
      // hard failure and duplicate our fallback.
      maxRetries: 0
    };

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: models.primary(),
        ...generateArgs
      });
    } catch (primaryErr) {
      console.warn(
        "[agent-loop] AI error on primary model, retrying with fallback",
        { model: modelId, error: String(primaryErr) }
      );
      modelId = models.fallbackId();
      result = await generateText({
        model: models.fallback(),
        ...generateArgs
      });
    }

    const replyText = result.text.trim();
    const finishReason = result.finishReason;

    if (!replyText || finishReason === "length") {
      if (finishReason === "length") {
        console.warn(
          "[agent-loop] model response truncated (finish_reason=length)",
          { model: modelId }
        );
      } else {
        console.warn("[agent-loop] empty response from model", {
          model: modelId,
          finishReason
        });
      }
      return TRANSIENT_REPLY;
    }

    await session.appendMessage(assistantSessionMessage(replyText));
    return replyText;
  } catch (err) {
    console.error("[agent-loop] turn failed", {
      model: modelId,
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    return isTransientAiError(err) ? TRANSIENT_REPLY : args.unexpectedReply;
  }
}

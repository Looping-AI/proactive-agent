import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";
import type { ToolSet } from "ai";
import { generateText, stepCountIs } from "ai";
import type { ModelPair } from "./model";
import { MAX_STEPS } from "./config";
import { textOf } from "./messages";

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

export interface AgentTurnConfig {
  /** Primary + fallback model pair. */
  models: ModelPair;
  /** Frozen system prompt for this turn (soul + caller context). */
  system: string;
  /** Tools the model may call this turn. */
  tools: ToolSet;
  /** Friendly reply for an unexpected (non-transient) failure. */
  unexpectedReply: string;
}

function publish(
  eventBus: ExecutionEventBus,
  contextId: string,
  text: string
): void {
  const reply: Message = {
    kind: "message",
    messageId: crypto.randomUUID(),
    role: "agent",
    parts: [{ kind: "text", text }],
    contextId
  };
  eventBus.publish(reply);
}

/**
 * Run a single stateless agent turn: a Workers-AI `generateText` tool loop over
 * the one inbound user message (primary → fallback model on any error), publish
 * the final reply, and always `finished()`. No persistence — history/memory
 * arrive in a later phase. The `<turn>` provenance wrapper (if any) is left in
 * the user text verbatim for the model to read.
 */
export async function executeAgentTurn(
  requestContext: RequestContext,
  eventBus: ExecutionEventBus,
  cfg: AgentTurnConfig
): Promise<void> {
  const text = textOf(requestContext.userMessage);
  let modelId = cfg.models.primaryId();

  try {
    const generateArgs = {
      system: cfg.system,
      messages: [{ role: "user" as const, content: text }],
      tools: cfg.tools,
      stopWhen: stepCountIs(MAX_STEPS),
      // We do our own primary → fallback recovery below, so disable the SDK's
      // per-model exponential-backoff retries — they'd only add latency on a
      // hard failure and duplicate our fallback.
      maxRetries: 0
    };

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: cfg.models.primary(),
        ...generateArgs
      });
    } catch (primaryErr) {
      console.warn(
        "[agent-loop] AI error on primary model, retrying with fallback",
        {
          model: modelId,
          error: String(primaryErr),
          contextId: requestContext.contextId
        }
      );
      modelId = cfg.models.fallbackId();
      result = await generateText({
        model: cfg.models.fallback(),
        ...generateArgs
      });
    }

    const replyText = result.text.trim();
    const finishReason = result.finishReason;

    if (!replyText || finishReason === "length") {
      if (finishReason === "length") {
        console.warn(
          "[agent-loop] model response truncated (finish_reason=length)",
          { model: modelId, contextId: requestContext.contextId }
        );
      } else {
        console.warn("[agent-loop] empty response from model", {
          model: modelId,
          finishReason,
          contextId: requestContext.contextId
        });
      }
      publish(eventBus, requestContext.contextId, TRANSIENT_REPLY);
      return;
    }

    publish(eventBus, requestContext.contextId, replyText);
  } catch (err) {
    console.error("[agent-loop] turn failed", {
      contextId: requestContext.contextId,
      model: modelId,
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    const reply = isTransientAiError(err)
      ? TRANSIENT_REPLY
      : cfg.unexpectedReply;
    publish(eventBus, requestContext.contextId, reply);
  } finally {
    eventBus.finished();
  }
}

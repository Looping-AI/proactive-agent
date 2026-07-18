import type {
  FinishReason,
  PrepareStepFunction,
  StepResult,
  StopCondition,
  ToolSet
} from "ai";
import { generateText, stepCountIs } from "ai";
import type { ModelPair } from "./model";
import { MAX_STEPS } from "@/config";
import {
  assistantSessionMessage,
  toModelMessages,
  userSessionMessage
} from "./history";
import { SILENCE_GUIDANCE } from "./prompt";
import { SILENCE_TOOL_NAME } from "./tools";
import type { SessionLike } from "./session";

export const TRANSIENT_REPLY =
  "The AI service is temporarily unavailable. Please try again in a moment.";

/**
 * How a turn ended: with a reply to deliver, or with the agent deliberately
 * declining to answer (the model's first move was the `silence` tool). Distinct
 * from an empty reply, which means the model failed and yields
 * {@link TRANSIENT_REPLY}.
 */
export type TurnOutcome = { kind: "reply"; text: string } | { kind: "silent" };

/** The only part of a `StepResult` the silence predicates read. */
type ToolCallingStep = { toolCalls: ReadonlyArray<{ toolName: string }> };

/** A step whose one and only tool call is `silence`. Any text alongside it is irrelevant. */
export function isSilenceOnlyStep(step: ToolCallingStep): boolean {
  return (
    step.toolCalls.length === 1 &&
    step.toolCalls[0].toolName === SILENCE_TOOL_NAME
  );
}

/**
 * Whether a run was a silent turn: **exactly one step**, whose only tool call was
 * `silence`. Everything else — `silence` alongside a real tool, or `silence` on a
 * later step — is ignored, and the turn produces a normal reply.
 *
 * The `length === 1` guard is what enforces "first step only" at *runtime*.
 * `activeTools` (below) merely hides the tool from the model; the SDK still
 * resolves a tool call against the full, unfiltered map, so a model that names
 * `silence` on a later step executes it happily. Without this guard such a call
 * would silently discard a turn that had already done real work.
 */
export function isSilentTurn(steps: readonly ToolCallingStep[]): boolean {
  return steps.length === 1 && isSilenceOnlyStep(steps[0]);
}

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
  /**
   * Called with each **intermediate** assistant content message — text the model
   * emits in a step that also makes tool calls (`finishReason:"tool-calls"`), i.e.
   * before the final reply. Used to stream those messages out live; the final
   * reply is the return value, not an `onContent` call. `stepIndex` is the 0-based
   * step ordinal (stable enough across a primary→fallback re-run for the gateway
   * to dedupe on). Best-effort — the caller must swallow its own failures.
   */
  onContent?: (text: string, stepIndex: number) => void | Promise<void>;
}

/** A step is "intermediate" when it makes tool calls — more content follows. */
function isIntermediateStep(step: { finishReason: FinishReason }): boolean {
  return step.finishReason === "tool-calls";
}

/**
 * Returns a fresh `onStepFinish` callback for one `generateText` attempt.
 * Fires `onContent` for each intermediate step (text that accompanies tool
 * calls); the final step is skipped because its text is the return value.
 * A fresh handler per attempt resets the 0-based `stepIndex` counter so a
 * primary→fallback re-run reuses the same indices and the gateway dedupes.
 */
function buildIntermediateContentHandler(
  onContent: NonNullable<RunTurnArgs["onContent"]>
): (step: StepResult<ToolSet>) => Promise<void> {
  let stepIndex = 0;
  return async (step) => {
    const i = stepIndex++;
    if (!isIntermediateStep(step)) return;
    // A first-step `silence` call ends the turn with no reply, so text the model
    // wrote alongside it must not leak out as a `working` push. This is the only
    // place it can be caught: the SDK fires `onStepFinish` *before* it evaluates
    // `stopWhen`. Gated to step 0 because a `silence` call on any later step is
    // ignored (see `isSilentTurn`), making its text genuine intermediate content.
    if (i === 0 && isSilenceOnlyStep(step)) return;
    const content = step.text.trim();
    if (content) await onContent(content, i);
  };
}

/**
 * Run a single agent turn against the DO's continuous Session: append the user
 * message, run a Workers-AI `generateText` tool loop over the Session history
 * (primary → fallback model on any error), persist the assistant reply, and
 * return the final reply text. The inbound text keeps its `<turn>` provenance
 * wrapper verbatim for the model (and Phase-3 recall) to read.
 *
 * May instead resolve to `{ kind: "silent" }`: the agent sees every channel
 * message, so its first move can be the `silence` tool, ending the turn with no
 * reply. The user message is still appended either way — the agent reads the
 * channel whether or not it answers.
 *
 * **Never throws**: a transient (capacity/timeout) failure resolves to a
 * friendly "try again" message, an unexpected failure to `unexpectedReply`, so
 * the DO's `converse()` caller always gets an outcome to publish.
 */
export async function runTurn(args: RunTurnArgs): Promise<TurnOutcome> {
  const {
    session,
    text,
    systemSuffix,
    tools: extraTools,
    models,
    onContent
  } = args;
  let modelId = models.primaryId();

  try {
    await session.appendMessage(userSessionMessage(text));
    const history = await session.getHistory();
    const system = (await session.refreshSystemPrompt()) + systemSuffix;
    const tools = { ...(await session.tools()), ...extraTools };
    const withoutSilence = Object.keys(tools).filter(
      (name) => name !== SILENCE_TOOL_NAME
    );

    // Stop as soon as the model declines to answer — otherwise the SDK would
    // feed the (meaningless) `silence` result back and spend another step. The
    // two conditions are OR'd and disjoint: `stepCountIs` fires at MAX_STEPS,
    // `isSilentTurn` only ever at one step. Not `hasToolCall("silence")`, which
    // would also stop on a `silence` call we mean to ignore.
    const stopWhen: Array<StopCondition<ToolSet>> = [
      stepCountIs(MAX_STEPS),
      ({ steps }) => isSilentTurn(steps)
    ];

    // `silence` is a first-move-only escape hatch: once the model has committed
    // to real work it must finish the turn with a reply. So step 0 sees the full
    // toolset and the guidance explaining it; later steps see neither. (Omitting
    // a field here falls back to the outer `generateArgs` value.)
    const prepareStep: PrepareStepFunction<ToolSet> = ({ stepNumber }) =>
      stepNumber === 0
        ? { system: system + SILENCE_GUIDANCE }
        : { activeTools: withoutSilence };

    const generateArgs = {
      system,
      messages: toModelMessages(history),
      tools,
      stopWhen,
      prepareStep,
      // We do our own primary → fallback recovery below, so disable the SDK's
      // per-model exponential-backoff retries — they'd only add latency on a
      // hard failure and duplicate our fallback.
      maxRetries: 0
    };

    // Stream each intermediate content message (text on a step that also makes
    // tool calls) as it finishes. The final step (`stop`/`length`) is the reply
    // and is delivered via the return value, not here. Each attempt gets a fresh
    // handler so the 0-based stepIndex counter resets; a primary→fallback re-run
    // reuses the same index per position and the gateway dedupes by id.
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: models.primary(),
        ...generateArgs,
        onStepFinish: onContent
          ? buildIntermediateContentHandler(onContent)
          : undefined
      });
    } catch (primaryErr) {
      // The fallback re-runs the whole turn, so `prepareStep`'s stepNumber
      // restarts at 0 and the fallback model gets its own shot at `silence` —
      // which is what we want. Rare consequence: if the primary streamed a
      // `working` push and *then* threw, and the fallback opens with `silence`,
      // the gateway keeps that intermediate message and never gets a final one.
      console.warn(
        "[agent-loop] AI error on primary model, retrying with fallback",
        { model: modelId, error: String(primaryErr) }
      );
      modelId = models.fallbackId();
      result = await generateText({
        model: models.fallback(),
        ...generateArgs,
        onStepFinish: onContent
          ? buildIntermediateContentHandler(onContent)
          : undefined
      });
    }

    // Before the empty-text check below, which a silent turn would otherwise
    // trip: its step is `finishReason:"tool-calls"` with (usually) no text, and
    // would be reported to the caller as a model failure. Reading the outcome
    // off `result.steps` rather than trusting `stopWhen` also covers the case of
    // an invalid `silence` call, which exits the loop without consulting it.
    // Any text the model wrote alongside the call is discarded here, unread.
    if (isSilentTurn(result.steps)) {
      console.debug("[agent-loop] silent turn — no reply", { model: modelId });
      return { kind: "silent" };
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
      return { kind: "reply", text: TRANSIENT_REPLY };
    }

    await session.appendMessage(assistantSessionMessage(replyText));
    return { kind: "reply", text: replyText };
  } catch (err) {
    console.error("[agent-loop] turn failed", {
      model: modelId,
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    return {
      kind: "reply",
      text: isTransientAiError(err) ? TRANSIENT_REPLY : args.unexpectedReply
    };
  }
}

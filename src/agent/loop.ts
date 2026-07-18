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
import { NO_REPLY_GUIDANCE } from "./prompt";
import { NO_REPLY_TOOL_NAME } from "./tools";
import type { SessionLike } from "./session";

export const TRANSIENT_REPLY =
  "The AI service is temporarily unavailable. Please try again in a moment.";

/**
 * How a turn ended: with a reply to deliver, or with the agent deliberately
 * declining to answer (it called the `no_reply` tool without having sent
 * anything first). Distinct from an empty reply, which means the model failed and
 * yields {@link TRANSIENT_REPLY}.
 */
export type TurnOutcome =
  { kind: "reply"; text: string } | { kind: "no_reply" };

/** The only part of a `StepResult` the no-reply predicates read. */
type ToolCallingStep = { toolCalls: ReadonlyArray<{ toolName: string }> };

/** Whether a step calls `no_reply` at all — on its own or beside other tools. */
export function stepCallsNoReply(step: ToolCallingStep): boolean {
  return step.toolCalls.some((c) => c.toolName === NO_REPLY_TOOL_NAME);
}

/**
 * Whether a run declined to reply: the agent has **not sent anything this turn**
 * (`!repliedAny`) and its final step called `no_reply`. A `no_reply` call ends
 * the turn the moment it appears — even beside another tool, which still runs but
 * whose result is discarded — so the first step to call it is the last. A
 * `no_reply` after the agent already streamed content is the one thing ignored.
 *
 * `!repliedAny` is the runtime guard that lets `no_reply` be a *late* decision
 * (browse, then conclude there's nothing to add) while still forbidding it once
 * the agent has spoken. `activeTools` (below) merely hides the tool from the
 * model; the SDK still resolves a tool call against the full, unfiltered map, so
 * a model that names `no_reply` after speaking executes it happily — this flag is
 * what stops that from discarding a turn Slack has already seen.
 */
export function isNoReplyTurn(
  repliedAny: boolean,
  steps: readonly ToolCallingStep[]
): boolean {
  const last = steps.at(-1);
  return !repliedAny && last !== undefined && stepCallsNoReply(last);
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
    // A step that calls `no_reply` ends the turn with no reply, so text the model
    // wrote alongside it must not leak out as a `working` push (which would also
    // mark us as having spoken, via the caller's `repliedAny` tracker). This is
    // the only place it can be caught: the SDK fires `onStepFinish` *before* it
    // evaluates `stopWhen`. When the call is instead ignored (we've already
    // spoken), dropping that one intermediate message is harmless.
    if (stepCallsNoReply(step)) return;
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
 * May instead resolve to `{ kind: "no_reply" }`: the agent sees every channel
 * message and can call the `no_reply` tool to decline — either straight away or
 * after looking into something — as long as it has not streamed any content yet.
 * The user message is still appended either way, so the agent reads the channel
 * whether or not it answers.
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
    const withoutNoReply = Object.keys(tools).filter(
      (name) => name !== NO_REPLY_TOOL_NAME
    );

    // Whether the agent has streamed any user-facing content this turn. Flipped
    // by the tracked `onContent` below and read live by `prepareStep`/`stopWhen`.
    // It is the single signal behind `no_reply`: available until we speak, then
    // withdrawn. Turn-level (not per attempt), so a primary→fallback re-run after
    // the primary streamed inherits it and the fallback cannot go silent.
    let repliedAny = false;
    const tracked: RunTurnArgs["onContent"] = onContent
      ? async (content, i) => {
          repliedAny = true;
          await onContent(content, i);
        }
      : undefined;

    // Stop as soon as the agent declines — otherwise the SDK would feed the
    // (meaningless) `no_reply` result back and spend another step. The two
    // conditions are OR'd: `stepCountIs` caps the loop, `isNoReplyTurn` ends it on
    // a `no_reply` call we haven't disqualified. Not `hasToolCall("no_reply")`,
    // which would also stop on a `no_reply` call we mean to ignore (after the
    // agent has already spoken).
    const stopWhen: Array<StopCondition<ToolSet>> = [
      stepCountIs(MAX_STEPS),
      ({ steps }) => isNoReplyTurn(repliedAny, steps)
    ];

    // Offer `no_reply` (and the guidance explaining it) on every step until the
    // agent has spoken; withdraw both once it has. This lets the agent decline
    // late (look something up, then conclude there's nothing to add) while never
    // going silent after streaming content. (Omitting a field here falls back to
    // the outer `generateArgs` value.)
    const prepareStep: PrepareStepFunction<ToolSet> = () =>
      repliedAny
        ? { activeTools: withoutNoReply }
        : { system: system + NO_REPLY_GUIDANCE };

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
        onStepFinish: tracked
          ? buildIntermediateContentHandler(tracked)
          : undefined
      });
    } catch (primaryErr) {
      // The fallback re-runs the whole turn, but `repliedAny` is turn-level and
      // survives the re-run: if the primary already streamed a `working` push,
      // the fallback inherits `repliedAny === true` and cannot go silent, so it
      // must deliver a final reply. If nothing had streamed yet, the fallback is
      // free to decline just as the primary was.
      console.warn(
        "[agent-loop] AI error on primary model, retrying with fallback",
        { model: modelId, error: String(primaryErr) }
      );
      modelId = models.fallbackId();
      result = await generateText({
        model: models.fallback(),
        ...generateArgs,
        onStepFinish: tracked
          ? buildIntermediateContentHandler(tracked)
          : undefined
      });
    }

    // Before the empty-text check below, which a no-reply turn would otherwise
    // trip: its step is `finishReason:"tool-calls"` with (usually) no text, and
    // would be reported to the caller as a model failure. Reading the outcome
    // off `result.steps` rather than trusting `stopWhen` also covers the case of
    // an invalid `no_reply` call, which exits the loop without consulting it.
    // Any text the model wrote alongside the call is discarded here, unread.
    if (isNoReplyTurn(repliedAny, result.steps)) {
      console.debug("[agent-loop] no_reply — declining to answer", {
        model: modelId
      });
      return { kind: "no_reply" };
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

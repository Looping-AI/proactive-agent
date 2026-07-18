import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";
import {
  stepCallsNoReply,
  isNoReplyTurn,
  runTurn,
  TRANSIENT_REPLY
} from "@/agent/loop";
import { createModelPair, type ModelPair } from "@/agent/model";
import type { SessionLike } from "@/agent/session";
import { sessionText } from "@/agent/history";
import { NO_REPLY_TOOL_NAME, noReplyTool } from "@/agent/tools";
import { mockModel, recordCalls } from "./mock-model";

/** Minimal real tool used to exercise the multi-step tool-call loop. */
const ECHO_TOOL: ToolSet = {
  echo: tool({
    description: "Echoes its input back.",
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }) => text
  })
};

/** The real `no_reply` tool alongside `echo` — the production pairing. */
const NO_REPLY_AND_ECHO: ToolSet = {
  ...ECHO_TOOL,
  [NO_REPLY_TOOL_NAME]: noReplyTool
};

/** A step shaped just enough for the no-reply predicates. */
const step = (...toolNames: string[]) => ({
  toolCalls: toolNames.map((toolName) => ({ toolName }))
});

/** The verified-caller suffix a turn appends to the Session's soul block. */
const CALLER_SUFFIX = "\n\nCalling agent instance: Ada.";

/** Reply the DO returns on an unexpected (non-transient) failure — asserted by substring. */
const UNEXPECTED_REPLY =
  "Sorry, I hit an unexpected error handling that request.";

/** An in-memory SessionLike standing in for the DO's real continuous Session. */
class FakeSession implements SessionLike {
  messages: SessionMessage[] = [];
  system = "SOUL BLOCK\n\n## memory\n(empty)";

  appendMessage(m: SessionMessage) {
    this.messages.push(m);
  }
  async getHistory() {
    return this.messages;
  }
  async refreshSystemPrompt() {
    return this.system;
  }
  async tools(): Promise<ToolSet> {
    return {};
  }
  async getCompactions() {
    return [] as unknown[];
  }
}

function run(
  models: { model: LanguageModel; fallbackModel?: LanguageModel },
  text = "hello",
  extraTools: ToolSet = {}
) {
  const session = new FakeSession();
  return runTurn({
    session,
    text,
    systemSuffix: CALLER_SUFFIX,
    tools: extraTools,
    models: createModelPair(models),
    unexpectedReply: UNEXPECTED_REPLY
  }).then((outcome) => ({ outcome, session }));
}

/**
 * Build a `ModelPair` from raw factory functions. The error-path tests throw
 * *from the factory* (before `generateText` is ever called) to exercise the
 * fallback / outer-catch branches — rather than passing a model whose
 * `doGenerate` rejects into `generateText`, which leaks an unhandled rejection
 * through the AI SDK's telemetry span that workerd flags as a failure.
 */
function modelPair(
  primary: () => LanguageModel,
  fallback: () => LanguageModel
): ModelPair {
  return {
    primary,
    fallback,
    primaryId: () => "primary-model",
    fallbackId: () => "fallback-model"
  };
}

/** Drive a turn with a pre-built `ModelPair` (used by the error-path tests). */
function runPair(models: ModelPair, text = "hello") {
  return runTurn({
    session: new FakeSession(),
    text,
    systemSuffix: CALLER_SUFFIX,
    tools: {},
    models,
    unexpectedReply: UNEXPECTED_REPLY
  });
}

describe("runTurn — happy path", () => {
  it("returns the model's reply text", async () => {
    const { outcome } = await run({ model: mockModel({ text: "Hi Ada!" }) });
    expect(outcome).toEqual({ kind: "reply", text: "Hi Ada!" });
  });

  it("persists the user turn and the assistant reply to the session", async () => {
    const { session } = await run({ model: mockModel({ text: "remembered" }) });
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(sessionText(session.messages[0])).toBe("hello");
    expect(sessionText(session.messages[1])).toBe("remembered");
  });

  it("feeds prior history + soul + verified caller context to the model", async () => {
    let seenPrompt = "";
    const capturing = mockModel({ text: "ok" });
    const orig = capturing.doGenerate.bind(capturing);
    capturing.doGenerate = async (options: Parameters<typeof orig>[0]) => {
      seenPrompt = JSON.stringify(options.prompt);
      return orig(options);
    };
    await run({ model: capturing });
    // The Session's soul + memory block (system) and the verified caller suffix.
    expect(seenPrompt).toContain("SOUL BLOCK");
    expect(seenPrompt).toContain("Calling agent instance: Ada");
    // The inbound user turn reached the model as history.
    expect(seenPrompt).toContain("hello");
  });

  it("runs a tool call then returns the follow-up text", async () => {
    const { outcome } = await run(
      {
        model: mockModel(
          { toolCall: { toolName: "echo", input: { text: "ping" } } },
          { text: "I echoed: ping" }
        )
      },
      "hello",
      ECHO_TOOL
    );
    expect(outcome).toEqual({ kind: "reply", text: "I echoed: ping" });
  });

  it("streams intermediate content (text on a tool-call step) via onContent, not the final reply", async () => {
    const streamed: Array<{ text: string; index: number }> = [];
    const outcome = await runTurn({
      session: new FakeSession(),
      text: "hello",
      systemSuffix: CALLER_SUFFIX,
      tools: ECHO_TOOL,
      models: createModelPair({
        model: mockModel(
          {
            text: "thinking out loud",
            toolCall: { toolName: "echo", input: { text: "ping" } }
          },
          { text: "final answer" }
        )
      }),
      unexpectedReply: UNEXPECTED_REPLY,
      onContent: (text, index) => {
        streamed.push({ text, index });
      }
    });
    expect(outcome).toEqual({ kind: "reply", text: "final answer" });
    // The intermediate content streamed once (step 0); the final reply did not.
    expect(streamed).toEqual([{ text: "thinking out loud", index: 0 }]);
  });

  it("does not stream when the turn is a single content reply (no tool call)", async () => {
    const streamed: string[] = [];
    const outcome = await runTurn({
      session: new FakeSession(),
      text: "hello",
      systemSuffix: CALLER_SUFFIX,
      tools: {},
      models: createModelPair({ model: mockModel({ text: "just this" }) }),
      unexpectedReply: UNEXPECTED_REPLY,
      onContent: (text) => {
        streamed.push(text);
      }
    });
    expect(outcome).toEqual({ kind: "reply", text: "just this" });
    expect(streamed).toEqual([]);
  });
});

describe("runTurn — resilience", () => {
  it("falls back to the secondary model when the primary throws", async () => {
    const outcome = await runPair(
      modelPair(
        () => {
          throw new Error("primary boom");
        },
        () => mockModel({ text: "from fallback" })
      )
    );
    expect(outcome).toEqual({ kind: "reply", text: "from fallback" });
  });

  it("returns the transient message when both models are over capacity", async () => {
    const outcome = await runPair(
      modelPair(
        () => {
          throw new Error("capacity temporarily exceeded");
        },
        () => {
          throw new Error("capacity temporarily exceeded");
        }
      )
    );
    expect(outcome).toEqual({ kind: "reply", text: TRANSIENT_REPLY });
  });

  it("returns the transient message when the model returns empty text", async () => {
    const { outcome } = await run({ model: mockModel({ text: "" }) });
    expect(outcome).toEqual({ kind: "reply", text: TRANSIENT_REPLY });
  });

  it("returns the unexpected-error reply on a non-transient failure", async () => {
    const outcome = await runPair(
      modelPair(
        () => {
          throw new Error("kaboom");
        },
        () => {
          throw new Error("kaboom");
        }
      )
    );
    expect(outcome).toEqual({ kind: "reply", text: UNEXPECTED_REPLY });
  });
});

describe("stepCallsNoReply", () => {
  it("is true whenever the step calls no_reply, alone or alongside another tool", () => {
    expect(stepCallsNoReply(step(NO_REPLY_TOOL_NAME))).toBe(true);
    expect(stepCallsNoReply(step(NO_REPLY_TOOL_NAME, "echo"))).toBe(true);
    expect(stepCallsNoReply(step("echo"))).toBe(false);
    expect(stepCallsNoReply(step())).toBe(false);
  });
});

describe("isNoReplyTurn", () => {
  it("is true for a final step that calls no_reply when nothing was said", () => {
    expect(isNoReplyTurn(false, [step(NO_REPLY_TOOL_NAME)])).toBe(true);
  });

  it("is true for a late no_reply after silent tool work (the softening)", () => {
    // The whole point: browse (or otherwise act) without speaking, then conclude
    // there's nothing to add. Allowed as long as nothing streamed.
    expect(isNoReplyTurn(false, [step("echo"), step(NO_REPLY_TOOL_NAME)])).toBe(
      true
    );
  });

  it("is true even when no_reply shares its step with another tool", () => {
    // The step's other tool ran, but a no_reply call concludes the turn — no
    // "must be your only call" requirement.
    expect(isNoReplyTurn(false, [step(NO_REPLY_TOOL_NAME, "echo")])).toBe(true);
  });

  it("is false once the agent has spoken this turn", () => {
    // `activeTools` only hides the tool; the SDK resolves a hallucinated call
    // against the unfiltered map. `repliedAny` is the guard that a no_reply after
    // streaming content must not discard a turn Slack has already seen.
    expect(isNoReplyTurn(true, [step(NO_REPLY_TOOL_NAME)])).toBe(false);
  });

  it("is false for a plain tool call and no steps", () => {
    expect(isNoReplyTurn(false, [step("echo")])).toBe(false);
    expect(isNoReplyTurn(false, [])).toBe(false);
  });
});

describe("runTurn — no_reply", () => {
  it("declines when the model's first move is no_reply", async () => {
    const { outcome, session } = await run(
      { model: mockModel({ toolCall: { toolName: NO_REPLY_TOOL_NAME } }) },
      "lol same",
      NO_REPLY_AND_ECHO
    );
    expect(outcome).toEqual({ kind: "no_reply" });
    // The agent read the channel but did not answer: user turn kept, no reply.
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
    expect(sessionText(session.messages[0])).toBe("lol same");
  });

  it("declines after silent tool work — browse, then conclude nothing to add", async () => {
    const { outcome } = await run(
      {
        model: mockModel(
          { toolCall: { toolName: "echo", input: { text: "look" } } },
          { toolCall: { toolName: NO_REPLY_TOOL_NAME } }
        )
      },
      "did anyone try the staging URL?",
      NO_REPLY_AND_ECHO
    );
    expect(outcome).toEqual({ kind: "no_reply" });
  });

  it("discards text written alongside a lone no_reply call, and never streams it", async () => {
    const streamed: string[] = [];
    const outcome = await runTurn({
      session: new FakeSession(),
      text: "hello",
      systemSuffix: CALLER_SUFFIX,
      tools: NO_REPLY_AND_ECHO,
      models: createModelPair({
        model: mockModel({
          text: "this must never reach Slack",
          toolCall: { toolName: NO_REPLY_TOOL_NAME }
        })
      }),
      unexpectedReply: UNEXPECTED_REPLY,
      onContent: (text) => {
        streamed.push(text);
      }
    });
    expect(outcome).toEqual({ kind: "no_reply" });
    expect(streamed).toEqual([]);
  });

  it("concludes on no_reply even when another tool shares the step", async () => {
    const { model, calls } = recordCalls(
      mockModel(
        {
          toolCalls: [
            { toolName: NO_REPLY_TOOL_NAME },
            { toolName: "echo", input: { text: "ping" } }
          ]
        },
        { text: "I echoed: ping" }
      )
    );
    const { outcome } = await run({ model }, "hello", NO_REPLY_AND_ECHO);
    // The no_reply call ends the turn — echo ran but its result is discarded, and
    // the follow-up reply step is never reached.
    expect(outcome).toEqual({ kind: "no_reply" });
    expect(calls).toHaveLength(1);
  });

  it("withdraws no_reply once the agent has streamed content, forcing a reply", async () => {
    const { model, calls } = recordCalls(
      mockModel(
        {
          text: "checking…",
          toolCall: { toolName: "echo", input: { text: "ping" } }
        },
        { toolCall: { toolName: NO_REPLY_TOOL_NAME } },
        { text: "done" }
      )
    );
    const streamed: string[] = [];
    const outcome = await runTurn({
      session: new FakeSession(),
      text: "hello",
      systemSuffix: CALLER_SUFFIX,
      tools: NO_REPLY_AND_ECHO,
      models: createModelPair({ model }),
      unexpectedReply: UNEXPECTED_REPLY,
      onContent: (text) => {
        streamed.push(text);
      }
    });

    // Having said "checking…", the agent owes a conclusion — a later no_reply is
    // ignored and the turn ends with the real reply.
    expect(outcome).toEqual({ kind: "reply", text: "done" });
    expect(streamed).toEqual(["checking…"]);
    // Offered on step 0 (nothing said yet), withdrawn from step 1 on (spoken).
    expect(calls[0].tools).toContain(NO_REPLY_TOOL_NAME);
    expect(calls[0].prompt).toContain("Staying silent is the right default");
    expect(calls[1].tools).not.toContain(NO_REPLY_TOOL_NAME);
    expect(calls[1].tools).toContain("echo");
    expect(calls[1].prompt).not.toContain(
      "Staying silent is the right default"
    );
  });
});

describe("runTurn — no_reply across the primary→fallback boundary", () => {
  it("lets the fallback decline when the primary failed before speaking", async () => {
    // Chatter + a primary capacity blip: nothing was streamed, so the fallback
    // is still free to stay silent (Scenario A).
    const outcome = await runTurn({
      session: new FakeSession(),
      text: "lol same",
      systemSuffix: CALLER_SUFFIX,
      tools: NO_REPLY_AND_ECHO,
      models: modelPair(
        () => {
          throw new Error("capacity temporarily exceeded");
        },
        () => mockModel({ toolCall: { toolName: NO_REPLY_TOOL_NAME } })
      ),
      unexpectedReply: UNEXPECTED_REPLY
    });
    expect(outcome).toEqual({ kind: "no_reply" });
  });

  it("forbids the fallback from declining once the primary has streamed", async () => {
    // Primary streams a working push, then fails mid-loop. The fallback inherits
    // repliedAny === true: no_reply is neither offered nor honored, so a final
    // reply always lands (Scenario B — never a stranded ⏳).
    const primary = mockModel({
      text: "checking…",
      toolCall: { toolName: "echo", input: { text: "x" } }
    });
    const origGen = primary.doGenerate.bind(primary);
    let calls = 0;
    primary.doGenerate = async (o: Parameters<typeof origGen>[0]) => {
      if (calls++ === 1) throw new Error("capacity temporarily exceeded");
      return origGen(o);
    };
    const { model: fallback, calls: fallbackCalls } = recordCalls(
      mockModel(
        { toolCall: { toolName: NO_REPLY_TOOL_NAME } },
        { text: "here is the answer" }
      )
    );
    const streamed: string[] = [];
    const outcome = await runTurn({
      session: new FakeSession(),
      text: "what's the staging URL?",
      systemSuffix: CALLER_SUFFIX,
      tools: NO_REPLY_AND_ECHO,
      models: modelPair(
        () => primary,
        () => fallback
      ),
      unexpectedReply: UNEXPECTED_REPLY,
      onContent: (text) => {
        streamed.push(text);
      }
    });

    expect(streamed).toEqual(["checking…"]); // the primary spoke before failing
    expect(outcome).toEqual({ kind: "reply", text: "here is the answer" });
    // The fallback was never even offered no_reply.
    expect(fallbackCalls[0].tools).not.toContain(NO_REPLY_TOOL_NAME);
  });
});

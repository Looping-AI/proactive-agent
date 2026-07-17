import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";
import {
  isSilenceOnlyStep,
  isSilentTurn,
  runTurn,
  TRANSIENT_REPLY
} from "@/agent/loop";
import { createModelPair, type ModelPair } from "@/agent/model";
import type { SessionLike } from "@/agent/session";
import { sessionText } from "@/agent/history";
import { SILENCE_TOOL_NAME, silenceTool } from "@/agent/tools";
import { mockModel, recordCalls } from "./mock-model";

/** Minimal real tool used to exercise the multi-step tool-call loop. */
const ECHO_TOOL: ToolSet = {
  echo: tool({
    description: "Echoes its input back.",
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }) => text
  })
};

/** The real `silence` tool alongside `echo` — the production pairing. */
const SILENCE_AND_ECHO: ToolSet = {
  ...ECHO_TOOL,
  [SILENCE_TOOL_NAME]: silenceTool
};

/** A step shaped just enough for the silence predicates. */
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

describe("isSilenceOnlyStep", () => {
  it("is true only for a lone silence call", () => {
    expect(isSilenceOnlyStep(step(SILENCE_TOOL_NAME))).toBe(true);
    expect(isSilenceOnlyStep(step(SILENCE_TOOL_NAME, "echo"))).toBe(false);
    expect(isSilenceOnlyStep(step("echo"))).toBe(false);
    expect(isSilenceOnlyStep(step())).toBe(false);
  });
});

describe("isSilentTurn", () => {
  it("is true for a single step that only called silence", () => {
    expect(isSilentTurn([step(SILENCE_TOOL_NAME)])).toBe(true);
  });

  it("is false once the turn has done real work", () => {
    // The guard that `activeTools` alone cannot provide: the SDK resolves tool
    // calls against the unfiltered map, so a model naming `silence` on a later
    // step still executes it. It must not discard a turn already underway.
    expect(isSilentTurn([step("echo"), step(SILENCE_TOOL_NAME)])).toBe(false);
  });

  it("is false for a mixed call, a plain tool call, and no steps", () => {
    expect(isSilentTurn([step(SILENCE_TOOL_NAME, "echo")])).toBe(false);
    expect(isSilentTurn([step("echo")])).toBe(false);
    expect(isSilentTurn([])).toBe(false);
  });
});

describe("runTurn — silence", () => {
  it("returns a silent outcome when the model's first move is silence", async () => {
    const { outcome, session } = await run(
      { model: mockModel({ toolCall: { toolName: SILENCE_TOOL_NAME } }) },
      "lol same",
      SILENCE_AND_ECHO
    );
    expect(outcome).toEqual({ kind: "silent" });
    // The agent read the channel but did not answer: user turn kept, no reply.
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
    expect(sessionText(session.messages[0])).toBe("lol same");
  });

  it("discards text written alongside a lone silence call, and never streams it", async () => {
    const streamed: string[] = [];
    const outcome = await runTurn({
      session: new FakeSession(),
      text: "hello",
      systemSuffix: CALLER_SUFFIX,
      tools: SILENCE_AND_ECHO,
      models: createModelPair({
        model: mockModel({
          text: "this must never reach Slack",
          toolCall: { toolName: SILENCE_TOOL_NAME }
        })
      }),
      unexpectedReply: UNEXPECTED_REPLY,
      onContent: (text) => {
        streamed.push(text);
      }
    });
    expect(outcome).toEqual({ kind: "silent" });
    expect(streamed).toEqual([]);
  });

  it("ignores silence called alongside another tool and replies normally", async () => {
    const { model, calls } = recordCalls(
      mockModel(
        {
          toolCalls: [
            { toolName: SILENCE_TOOL_NAME },
            { toolName: "echo", input: { text: "ping" } }
          ]
        },
        { text: "I echoed: ping" }
      )
    );
    const { outcome } = await run({ model }, "hello", SILENCE_AND_ECHO);
    expect(outcome).toEqual({ kind: "reply", text: "I echoed: ping" });
    // The loop continued rather than halting on the unhonoured silence call.
    expect(calls).toHaveLength(2);
  });

  it("ignores a silence call made after the turn has done real work", async () => {
    const { outcome } = await run(
      {
        model: mockModel(
          { toolCall: { toolName: "echo", input: { text: "ping" } } },
          { toolCall: { toolName: SILENCE_TOOL_NAME } },
          { text: "done" }
        )
      },
      "hello",
      SILENCE_AND_ECHO
    );
    expect(outcome).toEqual({ kind: "reply", text: "done" });
  });

  it("offers silence and its guidance on the first step only", async () => {
    const { model, calls } = recordCalls(
      mockModel(
        { toolCall: { toolName: "echo", input: { text: "ping" } } },
        { text: "done" }
      )
    );
    await run({ model }, "hello", SILENCE_AND_ECHO);

    expect(calls).toHaveLength(2);
    expect(calls[0].tools).toContain(SILENCE_TOOL_NAME);
    expect(calls[0].prompt).toContain("Staying silent is the right default");

    // Once the model has committed to real work, the escape hatch is withdrawn —
    // tool and guidance both — but every other tool stays.
    expect(calls[1].tools).not.toContain(SILENCE_TOOL_NAME);
    expect(calls[1].tools).toContain("echo");
    expect(calls[1].prompt).not.toContain(
      "Staying silent is the right default"
    );
  });
});

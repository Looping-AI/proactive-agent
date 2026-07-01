import { describe, it, expect } from "vitest";
import type { Message } from "@a2a-js/sdk";
import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { LlmExecutor } from "@/agent/executor";
import { TRANSIENT_REPLY } from "@/agent/loop";
import type { Env } from "@/env";
import type { GatewayIdentity } from "@/auth/verify";
import { mockModel, throwingModel } from "./mock-model";

// The model is always injected via overrides, so `env.AI` is never touched.
const ENV = {} as Env;

function makeCtx(text: string, contextId = "ctx-1"): RequestContext {
  return {
    userMessage: {
      kind: "message",
      messageId: "m1",
      role: "user",
      parts: [{ kind: "text", text }],
      contextId
    },
    contextId
  } as unknown as RequestContext;
}

function makeBus() {
  const published: Message[] = [];
  let done = false;
  const bus = {
    publish: (m: Message) => {
      published.push(m);
    },
    finished: () => {
      done = true;
    }
  } as unknown as ExecutionEventBus;
  return {
    bus,
    get published() {
      return published;
    },
    get done() {
      return done;
    }
  };
}

function run(
  identity: GatewayIdentity,
  overrides: ConstructorParameters<typeof LlmExecutor>[2],
  ctx = makeCtx("hello")
) {
  const tracker = makeBus();
  return new LlmExecutor(identity, ENV, overrides)
    .execute(ctx, tracker.bus)
    .then(() => tracker);
}

describe("LlmExecutor — happy path", () => {
  it("publishes the model's reply as a single agent message with the contextId", async () => {
    const { published } = await run(
      { name: "Ada" },
      { model: mockModel({ text: "Hi Ada!" }) },
      makeCtx("hello", "ctx-42")
    );
    expect(published).toHaveLength(1);
    expect(published[0].role).toBe("agent");
    expect(published[0].contextId).toBe("ctx-42");
    expect(published[0].parts[0]).toMatchObject({ text: "Hi Ada!" });
  });

  it("always calls bus.finished()", async () => {
    const { done } = await run(
      { name: "Ada" },
      { model: mockModel({ text: "ok" }) }
    );
    expect(done).toBe(true);
  });

  it("runs a tool call then returns the follow-up text", async () => {
    const { published } = await run(
      { name: "Ada" },
      {
        model: mockModel(
          { toolCall: { toolName: "echo", input: { text: "ping" } } },
          { text: "I echoed: ping" }
        )
      }
    );
    expect(published[0].parts[0]).toMatchObject({ text: "I echoed: ping" });
  });
});

describe("LlmExecutor — resilience", () => {
  it("falls back to the secondary model when the primary throws", async () => {
    const { published } = await run(
      { name: "Ada" },
      {
        model: throwingModel("primary boom"),
        fallbackModel: mockModel({ text: "from fallback" })
      }
    );
    expect(published[0].parts[0]).toMatchObject({ text: "from fallback" });
  });

  it("replies with the transient message when both models are over capacity", async () => {
    const { published } = await run(
      { name: "Ada" },
      {
        model: throwingModel("capacity temporarily exceeded"),
        fallbackModel: throwingModel("capacity temporarily exceeded")
      }
    );
    expect(published[0].parts[0]).toMatchObject({ text: TRANSIENT_REPLY });
  });

  it("replies with the transient message when the model returns empty text", async () => {
    const { published } = await run(
      { name: "Ada" },
      { model: mockModel({ text: "" }) }
    );
    expect(published[0].parts[0]).toMatchObject({ text: TRANSIENT_REPLY });
  });

  it("replies with a generic error on an unexpected (non-transient) failure", async () => {
    const { published } = await run(
      { name: "Ada" },
      {
        model: throwingModel("kaboom"),
        fallbackModel: throwingModel("kaboom")
      }
    );
    const text = (published[0].parts[0] as { text: string }).text;
    expect(text).not.toBe(TRANSIENT_REPLY);
    expect(text).toMatch(/unexpected error/i);
  });
});

describe("LlmExecutor — bus contract", () => {
  it("cancelTask resolves without error", async () => {
    await expect(
      new LlmExecutor({}, ENV).cancelTask()
    ).resolves.toBeUndefined();
  });
});

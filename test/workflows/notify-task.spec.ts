import { describe, it, expect, vi, afterEach } from "vitest";
import { importJWK, jwtVerify } from "jose";
import type { WorkflowStep } from "cloudflare:workers";
import type { Task } from "@a2a-js/sdk";
import { runNotifyTask, type NotifyTaskParams } from "@/workflows/notify-task";
import {
  TEST_AGENT_PRIVATE_JWK,
  GATEWAY_ORIGIN,
  AGENT_ORIGIN
} from "../fixtures";

const PUSH_URL = `${GATEWAY_ORIGIN}/a2a/notifications`;

/** Records what the workflow drove on the DO. */
interface StubCapture {
  working?: string;
  converse?: { text: string; identity: unknown };
  completed?: { task: Task };
  reply: string;
  currentState?: Task["status"]["state"];
}

/** Minimal fake env exposing just the DO RPC surface the workflow calls. */
function fakeEnv(cap: StubCapture): Env {
  const stub = {
    markWorking: async (id: string) => {
      cap.working = id;
    },
    converse: async (text: string, identity: unknown) => {
      cap.converse = { text, identity };
      return cap.reply;
    },
    getTask: async (): Promise<Task | null> =>
      cap.currentState
        ? ({ status: { state: cap.currentState } } as unknown as Task)
        : null,
    completeTask: async (task: Task) => {
      cap.completed = { task };
    }
  };
  return {
    A2A_SIGNING_KEY: JSON.stringify(TEST_AGENT_PRIVATE_JWK),
    ProactiveAgent: {
      idFromName: (name: string) => ({ name }),
      get: () => stub
    }
  } as unknown as Env;
}

/** A `step` that just runs each callback inline (no durability/retry in tests). */
const inlineStep = {
  do: (async (_name: string, a: unknown, b?: unknown) => {
    const cb = (typeof a === "function" ? a : b) as (ctx: unknown) => unknown;
    return cb({});
  }) as WorkflowStep["do"]
} as unknown as WorkflowStep;

function params(): NotifyTaskParams {
  return {
    taskId: "task-1",
    text: "hi there",
    identity: { key: "custom:1:ada", name: "Ada", kind: "custom" },
    contextId: "ctx-1",
    pushUrl: PUSH_URL,
    pushToken: "tok-xyz",
    jku: `${AGENT_ORIGIN}/.well-known/jwks.json`
  };
}

async function agentPublicKey() {
  const { d: _d, ...pub } = TEST_AGENT_PRIVATE_JWK;
  void _d;
  return importJWK(pub, "EdDSA");
}

function runWorkflow(env: Env, p: NotifyTaskParams) {
  return runNotifyTask(env, p, inlineStep);
}

describe("NotifyTaskWorkflow", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("generates the reply and POSTs a signed completed-Task callback to the gateway", async () => {
    const cap: StubCapture = { reply: "the answer" };
    const captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.init = init;
        return new Response("ok", { status: 200 });
      })
    );

    await runWorkflow(fakeEnv(cap), params());

    // Drove the DO: working → converse(text, identity) → completeTask.
    expect(cap.working).toBe("task-1");
    expect(cap.converse?.text).toBe("hi there");
    expect((cap.converse?.identity as { key: string }).key).toBe(
      "custom:1:ada"
    );
    expect(cap.completed?.task.status.state).toBe("completed");

    // POSTed to the gateway webhook with the validation token + signed JWT.
    expect(captured.url).toBe(PUSH_URL);
    const headers = new Headers(captured.init?.headers);
    expect(headers.get("x-a2a-notification-token")).toBe("tok-xyz");

    const bearer =
      headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const { payload } = await jwtVerify(bearer, await agentPublicKey(), {
      audience: PUSH_URL,
      algorithms: ["EdDSA"]
    });
    expect(payload.aud).toBe(PUSH_URL);

    const body = JSON.parse(captured.init?.body as string) as Task;
    expect(body.kind).toBe("task");
    expect(body.id).toBe("task-1");
    expect(body.status.state).toBe("completed");
    expect(body.status.message?.parts?.[0]).toMatchObject({
      kind: "text",
      text: "the answer"
    });
  });

  it("skips the callback when the task was canceled before completion", async () => {
    const cap: StubCapture = { reply: "the answer", currentState: "canceled" };
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await runWorkflow(fakeEnv(cap), params());

    expect(cap.completed).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

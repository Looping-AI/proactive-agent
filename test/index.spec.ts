import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import worker from "@/index";
import type { Task } from "@a2a-js/sdk";
import type { ProactiveAgent } from "@/proactive-agent";
import type { NotifyTaskParams } from "@/workflows/notify-task";
import { workflowIdForMessage } from "@/a2a/executor";
import { buildSubmittedTask } from "@/a2a/notify";
import type { GatewayIdentity } from "@/a2a/verify";
import { GATEWAY_ORIGIN, AGENT_ORIGIN } from "./fixtures";
import { makeGatewayToken } from "./helpers/auth";

const PUSH_URL = `${GATEWAY_ORIGIN}/a2a/notifications`;
const PUSH_TOKEN = "push-token-abc";

/** Captures what the Worker's executor did: the DO key, `beginTask` args, workflow create. */
interface Capture {
  name?: string;
  beginTask?: { messageId: string; taskId: string; contextId: string };
  workflow?: { id?: string; params?: NotifyTaskParams };
}

/**
 * A fake `ProactiveAgent` namespace: records the `idFromName` key and answers the
 * task-state RPC methods the accept path + SDK touch (`beginTask` returns a
 * submitted Task; `getTask`/`saveTask` back the durable store) — so we can assert
 * the Worker's accept behavior without a real DO.
 */
function fakeProactiveAgent(
  capture: Capture
): DurableObjectNamespace<ProactiveAgent> {
  const tasks = new Map<string, Task>();
  const stub = {
    beginTask: async (input: {
      messageId: string;
      taskId: string;
      contextId: string;
    }) => {
      capture.beginTask = input;
      const task = buildSubmittedTask(input.taskId, input.contextId);
      tasks.set(task.id, task);
      return task;
    },
    getTask: async (id: string) => tasks.get(id) ?? null,
    saveTask: async (task: Task) => {
      tasks.set(task.id, task);
    },
    cancelTask: async () => null
  };
  return {
    idFromName: (name: string) => {
      capture.name = name;
      return { name } as unknown as DurableObjectId;
    },
    get: () => stub as unknown as DurableObjectStub<ProactiveAgent>
  } as unknown as DurableObjectNamespace<ProactiveAgent>;
}

/** A fake `NOTIFY_WORKFLOW` binding capturing the single `create` call. */
function fakeWorkflow(capture: Capture): Env["NOTIFY_WORKFLOW"] {
  return {
    create: async (opts?: { id?: string; params?: NotifyTaskParams }) => {
      capture.workflow = { id: opts?.id, params: opts?.params };
      return {} as WorkflowInstance;
    },
    get: async () => ({}) as WorkflowInstance,
    createBatch: async () => []
  } as unknown as Env["NOTIFY_WORKFLOW"];
}

// The worker's fetch handler only takes (request, env) — it never uses ctx.
async function req(
  method: string,
  path: string,
  init?: RequestInit,
  workerEnv: Env = env
) {
  return worker.fetch(
    new Request(`${AGENT_ORIGIN}${path}`, { method, ...init }),
    workerEnv
  );
}

/** A `message/send` JSON-RPC body carrying `text` (with or without a push config). */
function sendBody(
  text: string,
  opts: {
    push?: boolean;
    method?: string;
    pushConfig?: { url?: string; token?: string };
  } = {}
) {
  const { push = true, method = "message/send", pushConfig } = opts;
  const resolvedPushConfig = pushConfig ?? { url: PUSH_URL, token: PUSH_TOKEN };
  return {
    jsonrpc: "2.0",
    id: "1",
    method,
    params: {
      message: {
        messageId: "msg-test-1",
        role: "user",
        kind: "message",
        parts: [{ kind: "text", text }],
        contextId: "ctx-1"
      },
      ...(push
        ? {
            configuration: {
              pushNotificationConfig: resolvedPushConfig
            }
          }
        : {})
    }
  };
}

/** POST a JSON-RPC body with a valid gateway token for `identity`. */
async function postRpc(
  body: unknown,
  identity: Partial<GatewayIdentity>,
  env: Env
) {
  const token = await makeGatewayToken({ audience: AGENT_ORIGIN, identity });
  return req(
    "POST",
    "/a2a",
    {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      }
    },
    env
  );
}

describe("GET /.well-known/jwks.json", () => {
  it("returns 200", async () => {
    const res = await req("GET", "/.well-known/jwks.json");
    expect(res.status).toBe(200);
  });

  it("returns a JWKS with exactly one key and no private d param", async () => {
    const res = await req("GET", "/.well-known/jwks.json");
    const body = await res.json<{ keys: Record<string, unknown>[] }>();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).not.toHaveProperty("d");
  });

  it("sets cache-control max-age", async () => {
    const res = await req("GET", "/.well-known/jwks.json");
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
  });
});

describe("GET /.well-known/agent-card.json", () => {
  it("returns 200", async () => {
    const res = await req("GET", "/.well-known/agent-card.json");
    expect(res.status).toBe(200);
  });

  it("returns a signed card with agent name and signatures array", async () => {
    const res = await req("GET", "/.well-known/agent-card.json");
    const body = await res.json<{
      name: string;
      signatures: unknown[];
    }>();
    expect(body.name).toBeTruthy();
    expect(Array.isArray(body.signatures)).toBe(true);
    expect(body.signatures.length).toBeGreaterThan(0);
  });
});

describe("POST /a2a", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const res = await req("POST", "/a2a", {
      body: "{}",
      headers: { "content-type": "application/json" }
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a malformed Bearer token", async () => {
    const res = await req("POST", "/a2a", {
      body: "{}",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not.a.real.jwt"
      }
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when jku origin is not in GATEWAY_ORIGINS", async () => {
    const token = await makeGatewayToken({ audience: AGENT_ORIGIN });
    const res = await req(
      "POST",
      "/a2a",
      {
        body: "{}",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        }
      },
      { ...env, GATEWAY_ORIGINS: "[]" }
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when the verified identity has no key (no DO to route to)", async () => {
    const res = await postRpc(
      {},
      { name: "NoKey", kind: "custom", workspaceId: 1 },
      env
    );
    expect(res.status).toBe(400);
  });

  it("accepts a message/send with a pushNotificationConfig: records a submitted Task and starts the notify workflow", async () => {
    const identity = {
      key: "custom:1:ada",
      name: "Ada",
      kind: "custom",
      workspaceId: 1
    };
    const capture: Capture = {};
    const res = await postRpc(sendBody("Hello from test!"), identity, {
      ...env,
      ProactiveAgent: fakeProactiveAgent(capture),
      NOTIFY_WORKFLOW: fakeWorkflow(capture)
    });

    expect(res.status).toBe(200);
    const body = await res.json<{
      result: { kind: string; id: string; status: { state: string } };
    }>();
    // The accept ack is a *submitted Task*, not a Message.
    expect(body.result.kind).toBe("task");
    expect(body.result.status.state).toBe("submitted");
    expect(body.result.id.length).toBeGreaterThan(0);

    // DO keyed by the verified identity.key; beginTask carries the message + context.
    expect(capture.name).toBe("custom:1:ada");
    expect(capture.beginTask?.messageId).toBe("msg-test-1");
    expect(capture.beginTask?.contextId).toBe("ctx-1");

    // The workflow is started with a deterministic id and the turn params.
    expect(capture.workflow?.id).toBe(workflowIdForMessage("msg-test-1"));
    expect(capture.workflow?.params?.text).toBe("Hello from test!");
    expect(capture.workflow?.params?.pushUrl).toBe(PUSH_URL);
    expect(capture.workflow?.params?.pushToken).toBe(PUSH_TOKEN);
    expect(capture.workflow?.params?.identity.key).toBe("custom:1:ada");
    expect(capture.workflow?.params?.jku).toBe(
      `${AGENT_ORIGIN}/.well-known/jwks.json`
    );
  });

  it("rejects a message/send without a pushNotificationConfig (async-only)", async () => {
    const res = await postRpc(
      sendBody("hi", { push: false }),
      { key: "custom:1:ada" },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ error?: { code: number } }>();
    expect(body.error?.code).toBe(-32602);
  });

  it("rejects a message/send with a pushNotificationConfig missing the token", async () => {
    const res = await postRpc(
      sendBody("hi", { pushConfig: { url: PUSH_URL } }),
      { key: "custom:1:ada" },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      error?: { code: number; message: string };
    }>();
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toMatch(/token/);
  });

  it("rejects a message/send with a malformed pushNotificationConfig url", async () => {
    const res = await postRpc(
      sendBody("hi", { pushConfig: { url: "not-a-url", token: PUSH_TOKEN } }),
      { key: "custom:1:ada" },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      error?: { code: number; message: string };
    }>();
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toMatch(/not a valid URL/);
  });

  it("rejects a streaming method with an unsupported-operation JSON-RPC error", async () => {
    // The card advertises `streaming: false`, so the a2a-js handler rejects
    // `message/stream` up front with a JSON-RPC error (HTTP 200, code -32004).
    const res = await postRpc(
      sendBody("hi", { method: "message/stream" }),
      { key: "custom:1:ada" },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ error?: { code: number } }>();
    expect(body.error?.code).toBe(-32004);
  });
});

describe("unknown routes", () => {
  it("returns 404 for GET /unknown", async () => {
    const res = await req("GET", "/unknown");
    expect(res.status).toBe(404);
  });

  it("returns 404 for GET /", async () => {
    const res = await req("GET", "/");
    expect(res.status).toBe(404);
  });
});

import { describe, it, expect } from "vitest";
import worker from "@/index";
import type { ProactiveAgent } from "@/proactive-agent";
import type { GatewayIdentity } from "@/a2a/verify";
import {
  makeGatewayToken,
  TEST_AGENT_PRIVATE_JWK,
  GATEWAY_ORIGIN,
  AGENT_ORIGIN
} from "./fixtures";

// Auth/card/jwks paths return before touching the DO or AI, so a stub `env`
// (no real `AI` binding, no DO) is enough for them; the DO-routed happy path
// injects a fake `ProactiveAgent` namespace (below) whose `converse()` captures the
// call. The real DO's Session/SQLite behavior is covered by test/do/**.
const TEST_ENV: Env = {
  A2A_SIGNING_KEY: JSON.stringify(TEST_AGENT_PRIVATE_JWK),
  GATEWAY_ORIGINS: JSON.stringify([GATEWAY_ORIGIN]),
  AI: undefined as unknown as Ai,
  ProactiveAgent: undefined as unknown as DurableObjectNamespace<ProactiveAgent>
};

/** Captures what the Worker's executor called on the DO (instance key + `converse` args). */
interface DoCapture {
  name?: string;
  text?: string;
  identity?: GatewayIdentity;
}

/**
 * A fake `ProactiveAgent` namespace: records the `idFromName` key and the
 * `converse(text, identity)` args, and returns `reply()` — so we can assert the
 * Worker's routing (DO keyed by `identity.key`, forwarded text + identity)
 * without a real DO. `reply` is synchronous and may throw to exercise the
 * executor's RPC-failure path — a sync throw rejects the single `converse`
 * promise directly, which workerd's tracker handles cleanly (a nested rejected
 * promise would be spuriously flagged as an unhandled rejection).
 */
function fakeProactiveAgent(
  capture: DoCapture,
  reply: (text: string, identity: GatewayIdentity) => string = () =>
    "ok from DO"
): DurableObjectNamespace<ProactiveAgent> {
  const stub = {
    converse: async (text: string, identity: GatewayIdentity) => {
      capture.text = text;
      capture.identity = identity;
      return reply(text, identity);
    }
  };
  return {
    idFromName: (name: string) => {
      capture.name = name;
      return { name } as unknown as DurableObjectId;
    },
    get: () => stub as unknown as DurableObjectStub<ProactiveAgent>
  } as unknown as DurableObjectNamespace<ProactiveAgent>;
}

// The worker's fetch handler only takes (request, env) — it never uses ctx.
async function req(
  method: string,
  path: string,
  init?: RequestInit,
  env: Env = TEST_ENV
) {
  return worker.fetch(
    new Request(`${AGENT_ORIGIN}${path}`, { method, ...init }),
    env
  );
}

/** A `message/send` JSON-RPC body carrying `text`. */
function sendBody(text: string, method = "message/send") {
  return {
    jsonrpc: "2.0",
    id: "1",
    method,
    params: {
      message: {
        messageId: "msg-test-1",
        role: "user",
        kind: "message",
        parts: [{ kind: "text", text }]
      }
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
      { ...TEST_ENV, GATEWAY_ORIGINS: "[]" }
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when the verified identity has no key (no DO to route to)", async () => {
    const res = await postRpc(
      {},
      { name: "NoKey", kind: "custom", workspaceId: 1 },
      TEST_ENV
    );
    expect(res.status).toBe(400);
  });

  it("routes an authenticated RPC into the caller's DO, forwarding the message text and verified identity", async () => {
    const identity = {
      key: "custom:1:ada",
      name: "Ada",
      kind: "custom",
      workspaceId: 1
    };
    // Nothing reads `message.metadata` anymore, so there is no spoofing surface
    // to defend here — the verified identity is passed as a native RPC arg.
    const capture: DoCapture = {};
    const res = await postRpc(sendBody("Hello from test!"), identity, {
      ...TEST_ENV,
      ProactiveAgent: fakeProactiveAgent(capture)
    });

    expect(res.status).toBe(200);
    const body = await res.json<{
      result: { role: string; parts: { text: string }[] };
    }>();
    expect(body.result.role).toBe("agent");
    // The DO's returned text is published as the single agent reply.
    expect(body.result.parts[0].text).toBe("ok from DO");

    // The DO instance is keyed by the verified identity.key.
    expect(capture.name).toBe("custom:1:ada");
    // The Worker forwarded the message text and the *verified* identity as RPC args.
    expect(capture.text).toBe("Hello from test!");
    expect(capture.identity).toMatchObject({
      key: "custom:1:ada",
      name: "Ada"
    });
  });

  it("still returns a well-formed 200 reply when the DO call fails", async () => {
    const capture: DoCapture = {};
    const res = await postRpc(
      sendBody("hi"),
      { key: "custom:1:ada" },
      {
        ...TEST_ENV,
        ProactiveAgent: fakeProactiveAgent(capture, () => {
          throw new Error("DO unreachable");
        })
      }
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      result: { role: string; parts: { text: string }[] };
    }>();
    expect(body.result.role).toBe("agent");
    expect(body.result.parts[0].text.length).toBeGreaterThan(0);
  });

  it("rejects a streaming method with an unsupported-operation JSON-RPC error", async () => {
    // The card advertises `streaming: false`, so the a2a-js handler rejects
    // `message/stream` up front with a JSON-RPC error (HTTP 200, code -32004) —
    // the executor / DO are never reached.
    const res = await postRpc(
      sendBody("hi", "message/stream"),
      { key: "custom:1:ada" },
      TEST_ENV
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

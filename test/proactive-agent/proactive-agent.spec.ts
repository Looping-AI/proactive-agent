import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { SessionMessage } from "agents/experimental/memory/session";
import type { ProactiveAgent } from "@/proactive-agent";
import { sessionText } from "@/agent/history";

/**
 * Real-DO integration coverage for the `ProactiveAgent` DO: its own Session
 * ownership — everything `test/index.spec.ts`'s fake-DO test deliberately does NOT
 * exercise. That test unit-tests the outer Worker's own routing/identity forwarding
 * in isolation; this one integration-tests the DO's internals for real (real
 * SQLite-backed Session), driving a turn via the `converse(...)` native RPC method
 * and reading state directly with `runInDurableObject`. It doesn't care how a
 * caller got here, so no gateway JWT is involved.
 *
 * `cloudflare:test`'s `env` is typed from the committed, generated
 * `worker-configuration.d.ts` ambient `Env`, which includes `ProactiveAgent`.
 */

const ProactiveAgentNamespace = env.ProactiveAgent;

/** The verified caller a real Worker would pass to `converse`. */
const IDENTITY = { key: "test:1:ada", name: "Ada", kind: "custom" };

/** Fresh, unique instance per test case — state must never leak between tests. */
function freshStub(label: string) {
  const id = ProactiveAgentNamespace.idFromName(
    `test:${label}:${crypto.randomUUID()}`
  );
  return ProactiveAgentNamespace.get(id);
}

/** Drive one turn through the DO's public RPC method. */
function converse(stub: ReturnType<typeof freshStub>, text: string) {
  return stub.converse(text, IDENTITY);
}

describe("ProactiveAgent — Session persistence (real SQLite)", () => {
  it("persists the raw user turn before the (unavailable) model is called", async () => {
    const stub = freshStub("session");
    // No working AI binding, so the turn takes its graceful error path and no
    // assistant reply is appended — but the user turn is persisted first.
    await converse(stub, "remember: my favorite color is teal");

    const history = await runInDurableObject(stub, (instance) =>
      instance.getSession().getHistory()
    );
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe("user");
    expect(sessionText(history[0])).toBe("remember: my favorite color is teal");
  });
});

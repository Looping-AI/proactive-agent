import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext
} from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";
import type { GatewayIdentity } from "./verify";
import type { Env } from "@/env";
import { textOf } from "./inbound";

/** Reply published when the DO call itself fails (unreachable / transport fault). */
const RPC_FAILURE_REPLY =
  "Sorry, I couldn't reach the agent runtime to handle that request. Please " +
  "try again, and check the agent's logs if it keeps happening.";

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
 * A2A executor: thin protocol glue between the Worker's JSON-RPC handler and the
 * caller's {@link file://../proactive-agent/index.ts ProactiveAgent} Durable Object. Extracts
 * the inbound text, dispatches a single native-RPC `converse()` call on the DO
 * instance keyed by the verified `identity.key`, publishes the reply, and
 * finishes. All turn logic (Session, tool loop, model fallback) lives inside the
 * DO — this class owns none of it.
 *
 * The verified caller identity comes from the constructor: the outer Worker
 * builds one executor per verified request, so a given executor only ever serves
 * that one caller (there is no per-turn identity to re-check).
 */
export class A2AExecutor implements AgentExecutor {
  constructor(
    private readonly identity: GatewayIdentity,
    private readonly env: Env
  ) {}

  execute = async (
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    try {
      const text = textOf(requestContext.userMessage);
      // `identity.key` is guaranteed non-null: the Worker rejects a keyless
      // identity (400) before constructing this executor.
      const stub = this.env.ProactiveAgent.get(
        this.env.ProactiveAgent.idFromName(this.identity.key as string)
      );
      const reply = await stub.converse(text, this.identity);
      publish(eventBus, requestContext.contextId, reply);
    } catch (err) {
      console.error("[executor] DO call failed", { err: String(err) });
      publish(eventBus, requestContext.contextId, RPC_FAILURE_REPLY);
    } finally {
      eventBus.finished();
    }
  };

  cancelTask = async (): Promise<void> => {};
}

import type { ProactiveAgent } from "./proactive-agent";

/**
 * The Worker's environment: bindings + secrets. Shared by the entrypoint
 * ({@link file://./index.ts}) and the agent runtime (model pair, executor) so the
 * `AI` binding is typed in one place.
 */
export interface Env {
  /** Ed25519 private JWK (with `kid`) used to sign this agent's AgentCard. */
  A2A_SIGNING_KEY: string;
  /** JSON array of trusted gateway origins, e.g. `["https://gw.example.com"]`. */
  GATEWAY_ORIGINS: string;
  /** Workers AI binding (routed through AI Gateway) backing the LLM tool loop. */
  AI: Ai;
  /**
   * The agent-runtime Durable Object namespace. One instance per calling
   * gateway-agent (keyed by the verified JWT `identity.key`); each holds the
   * SQLite-backed continuous {@link file://./agent/session.ts Session}. Typed
   * with the DO class so the Worker's native RPC calls (`stub.converse(...)`)
   * are checked at compile time. `import type` keeps this cycle-free at runtime.
   */
  ProactiveAgent: DurableObjectNamespace<ProactiveAgent>;
}

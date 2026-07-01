/**
 * The Worker's environment: bindings + non-secret vars. Shared by the entrypoint
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
}

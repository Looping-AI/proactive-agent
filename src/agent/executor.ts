import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext
} from "@a2a-js/sdk/server";
import type { GatewayIdentity } from "../auth/verify";
import type { Env } from "../env";
import { createModelPair, type ModelOverrides, type ModelPair } from "./model";
import { systemPrompt } from "./prompt";
import { buildTools } from "./tools";
import { executeAgentTurn } from "./loop";

const UNEXPECTED_REPLY =
  "Sorry, I hit an unexpected error handling that request. Please try again, " +
  "and check the agent's logs if it keeps happening.";

/**
 * A2A executor that answers each turn with a stateless Workers-AI tool loop,
 * greeting/serving the caller verified from the gateway JWT. Replaces the old
 * echo executor; state/memory arrive in a later phase.
 */
export class LlmExecutor implements AgentExecutor {
  private readonly models: ModelPair;

  constructor(
    private readonly identity: GatewayIdentity,
    env: Env,
    overrides: ModelOverrides = {}
  ) {
    this.models = createModelPair(env, overrides);
  }

  execute = async (
    ctx: RequestContext,
    bus: ExecutionEventBus
  ): Promise<void> => {
    await executeAgentTurn(ctx, bus, {
      models: this.models,
      system: systemPrompt(this.identity),
      tools: buildTools(this.identity),
      unexpectedReply: UNEXPECTED_REPLY
    });
  };

  cancelTask = async (): Promise<void> => {};
}

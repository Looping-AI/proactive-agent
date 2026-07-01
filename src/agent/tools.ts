import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { GatewayIdentity } from "../auth/verify";

/**
 * Phase-1 placeholder tools that prove tool-calling works end to end. Real domain
 * tools (with per-call authorization on the caller's roles) arrive in a later
 * phase. The pure handlers are exported separately from the AI-SDK `tool()`
 * wiring so they unit-test without an LLM.
 */

export interface WhoamiResult {
  key: string | null;
  name: string | null;
  kind: string | null;
  workspaceId: number | null;
}

/**
 * Report the verified identity of the calling gateway-agent instance carried
 * by the gateway JWT — not the Slack end user, which the gateway never
 * attests to remote agents. For the human speaker on a given turn, read the
 * `<turn from="…" id="…">` tag in the message text instead.
 */
export function whoami(identity: GatewayIdentity): WhoamiResult {
  return {
    key: identity.key ?? null,
    name: identity.name ?? null,
    kind: identity.kind ?? null,
    workspaceId: identity.workspaceId ?? null
  };
}

/** Echo text back verbatim. */
export function echo(args: { text: string }): { text: string } {
  return { text: args.text };
}

/**
 * Build the toolset for a turn, closing over the verified caller identity so
 * `whoami` can never be spoofed from model input.
 */
export function buildTools(identity: GatewayIdentity): ToolSet {
  return {
    whoami: tool({
      description:
        "Return the verified identity of the calling gateway-agent instance (as attested by the gateway JWT). This is not the Slack end user's identity — read the `<turn>` tag in the message text for that. Takes no input.",
      inputSchema: z.object({}),
      execute: async () => whoami(identity)
    }),
    echo: tool({
      description:
        "Echo a piece of text back verbatim. Useful for confirming tool calls work.",
      inputSchema: z.object({
        text: z.string().describe("The text to echo back")
      }),
      execute: async (args) => echo(args)
    })
  };
}

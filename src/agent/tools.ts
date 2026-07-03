import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { GatewayIdentity } from "@/a2a/verify";
import type { Embed } from "./model";
import { recallSearch, type RecallIndex, type RecallResult } from "./recall";
import { RECALL_TOP_K } from "@/config";

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
 * Per-instance dependencies for the `recall` tool. The Vectorize binding, the
 * caller-bound namespace, and the embed fn are all closed over — never tool
 * input — so the model can only ever supply a query string. `hasArchive` is the
 * gate: false until this caller's history has been compacted at least once.
 */
export interface RecallDeps {
  index: RecallIndex;
  namespace: string;
  embed: Embed;
  hasArchive: boolean;
}

export interface RecallToolResult {
  results: RecallResult[];
  /** Set when there is nothing to search yet, so the model doesn't over-read empty results. */
  note?: string;
}

/**
 * Semantically search this caller's archived (compacted-away) history. Pure
 * handler split from the AI-SDK wiring; the namespace/index/embed come from the
 * closure, only `query`/`limit` from the model.
 */
export async function recall(
  deps: RecallDeps,
  args: { query: string; limit?: number }
): Promise<RecallToolResult> {
  if (!deps.hasArchive) {
    return { results: [], note: "No older history has been archived yet." };
  }
  const results = await recallSearch(
    deps.index,
    deps.namespace,
    args.query,
    deps.embed,
    args.limit ?? RECALL_TOP_K
  );
  return { results };
}

/**
 * Build the toolset for a turn, closing over the verified caller identity so
 * `whoami` can never be spoofed from model input. The `recall` tool is included
 * only once this caller's history has been compacted at least once
 * (`recallDeps.hasArchive`) — there is nothing to search before that.
 */
export function buildTools(
  identity: GatewayIdentity,
  recallDeps?: RecallDeps
): ToolSet {
  const tools: ToolSet = {
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

  if (recallDeps?.hasArchive) {
    tools.recall = tool({
      description:
        "Search your own older conversation history with this caller that has scrolled out of the live context window (it was summarized during compaction). Use this to recall specific past details — quotes, decisions, facts — that you no longer have verbatim. Returns the most semantically similar archived messages with their author/channel/timestamp when known.",
      inputSchema: z.object({
        query: z.string().describe("What to look for in the archived history"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Max number of matches to return (default 5)")
      }),
      execute: async (args) => recall(recallDeps, args)
    });
  }

  return tools;
}

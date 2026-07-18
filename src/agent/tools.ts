import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { createQuickActionTools } from "agents/browser/ai";
import type { QuickActionBinding } from "agents/browser";
import type { Embed } from "./model";
import { recallSearch, type RecallIndex, type RecallResult } from "./recall";
import { RECALL_TOP_K } from "@/config";

/**
 * The agent's tools. Pure handlers are exported separately from the AI-SDK
 * `tool()` wiring so they unit-test without an LLM. Tools that depend on a
 * per-instance binding (Vectorize, Browser Rendering) are gated: registered
 * only when their dependency is present, with the binding closed over so it is
 * never model input.
 */

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
 * Web read/scrape tools (`browser_markdown`, `browser_extract`, `browser_links`,
 * `browser_scrape`), backed by Cloudflare Browser Rendering Quick Actions. The
 * binding is closed over, never model input; `maxChars` is lowered from the SDK
 * default to protect the small chat model's context window. `content` (raw HTML)
 * stays opt-in.
 */
export function buildBrowserTools(browser: QuickActionBinding): ToolSet {
  return createQuickActionTools({ browser, maxChars: 20000 });
}

/** The tool the model calls to end a turn without replying. */
export const NO_REPLY_TOOL_NAME = "no_reply";

/**
 * Tool result when a `no_reply` call is ignored. This is only ever read by the
 * model in one case: it has already sent something this turn (so the tool was
 * withdrawn) yet named it anyway — the call is ignored and it must finish with a
 * reply. When a `no_reply` call is instead honoured it ends the turn, and this
 * result is discarded unread.
 */
export const NO_REPLY_IGNORED =
  "Ignored: you have already sent a message this turn — finish with a reply.";

/**
 * End the turn without replying. The agent sees every message in its channels,
 * most of which are not for it, so this is how it declines to answer — either
 * straight away, or after looking into something and concluding there is nothing
 * worth adding. Calling it ends the turn at once: any other tool in the same step
 * still runs, but its result is discarded.
 *
 * Deliberately an ordinary tool with an ordinary no-op `execute` — the loop, not
 * the tool, decides what a `no_reply` call means (see
 * {@link file://./loop.ts} `isNoReplyTurn`). Two things here are load-bearing:
 *
 * - **`execute` must exist.** Once the agent has spoken the tool is withdrawn,
 *   but the model can still name it (the SDK resolves calls against the
 *   unfiltered map); that call is ignored and the loop must continue to a real
 *   reply. `generateText` only continues while every tool call in a step produced
 *   an output, so without `execute` that step would halt with no reply text and
 *   surface as a failure. Executing normally keeps the counts equal; the result
 *   is read only in that ignored case (and discarded when the call is honoured).
 * - **`reason` must stay optional.** A required field the model omits makes the
 *   SDK mark the call invalid and skip execution, halting the loop the same way.
 */
export const noReplyTool = tool({
  description:
    "End this turn without replying at all, when the message needs no answer from you (chatter, people talking to each other, anything not addressed to you) — or when you looked into it and there is genuinely nothing worth adding. Calling this ends the turn immediately, so do not pair it with a tool whose result you still need. Only available until you have sent anything this turn.",
  inputSchema: z.object({
    reason: z
      .string()
      .optional()
      .describe("One short phrase: why this message needs no reply.")
  }),
  execute: async () => NO_REPLY_IGNORED
});

/**
 * Build the toolset for a turn. Tools are gated on their per-instance
 * dependency: `recall` only once this caller's history has been compacted at
 * least once (`recallDeps.hasArchive`) — nothing to search before that — and the
 * browser tools only when a Browser Rendering binding is available. The Session
 * contributes its own `set_context` tool on top of these (merged in the loop),
 * so an otherwise-empty toolset here is fine.
 *
 * `no_reply` is ungated — it has no dependency to gate on. It is registered here
 * rather than in the loop so that withholding it (a turn that must be answered)
 * stays a matter of not building it, not a flag.
 */
export function buildTools(
  recallDeps?: RecallDeps,
  browser?: QuickActionBinding
): ToolSet {
  const tools: ToolSet = { [NO_REPLY_TOOL_NAME]: noReplyTool };

  if (browser) {
    Object.assign(tools, buildBrowserTools(browser));
  }

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

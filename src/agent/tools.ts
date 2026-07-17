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
export const SILENCE_TOOL_NAME = "silence";

/** Tool result when a `silence` call is ignored (it was not the only call). */
export const SILENCE_IGNORED = "Ignored: silence must be your only tool call.";

/**
 * End the turn without replying. The agent sees every message in its channels,
 * most of which are not for it, so this is how it declines to answer.
 *
 * Deliberately an ordinary tool with an ordinary no-op `execute` — the loop, not
 * the tool, decides what a `silence` call means (see
 * {@link file://./loop.ts} `isSilentTurn`). Two things here are load-bearing:
 *
 * - **`execute` must exist.** `generateText` only continues its loop while every
 *   tool call in a step produced an output, and that check runs *before*
 *   `stopWhen`. Omitting `execute` would halt the loop the moment `silence` was
 *   called alongside a real tool — exactly the case that must instead degrade to
 *   a normal reply. Executing normally keeps the counts equal and costs nothing:
 *   the result is read by the model only when the call is ignored, and discarded
 *   unread when the call is honoured.
 * - **`reason` must stay optional.** A required field the model omits makes the
 *   SDK mark the call invalid and skip execution, re-triggering that same early
 *   exit.
 */
export const silenceTool = tool({
  description:
    "End this turn without replying at all, when the message does not need an answer from you (chatter, people talking to each other, anything not addressed to you). Call this on its own — never alongside another tool — and only as your first action.",
  inputSchema: z.object({
    reason: z
      .string()
      .optional()
      .describe("One short phrase: why this message needs no reply.")
  }),
  execute: async () => SILENCE_IGNORED
});

/**
 * Build the toolset for a turn. Tools are gated on their per-instance
 * dependency: `recall` only once this caller's history has been compacted at
 * least once (`recallDeps.hasArchive`) — nothing to search before that — and the
 * browser tools only when a Browser Rendering binding is available. The Session
 * contributes its own `set_context` tool on top of these (merged in the loop),
 * so an otherwise-empty toolset here is fine.
 *
 * `silence` is ungated — it has no dependency to gate on. It is registered here
 * rather than in the loop so that withholding it (a turn that must be answered)
 * stays a matter of not building it, not a flag.
 */
export function buildTools(
  recallDeps?: RecallDeps,
  browser?: QuickActionBinding
): ToolSet {
  const tools: ToolSet = { [SILENCE_TOOL_NAME]: silenceTool };

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

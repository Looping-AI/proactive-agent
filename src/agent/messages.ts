import type { Message, Part } from "@a2a-js/sdk";

/**
 * Message glue for the agent runtime: pull plain text out of an inbound A2A
 * message, and parse the gateway-authored `<turn>` provenance wrapper.
 *
 * The gateway inlines a `<turn from="…" id="…" channel="…" at="…">…</turn>` tag
 * into the message text in multi-actor channels so the model (and, in later
 * phases, recall) can attribute "who said what". This agent only *parses* that
 * wrapper — it never authors one.
 */

/** Concatenate the text parts of an inbound A2A message. */
export function textOf(message: Message): string {
  return (message.parts ?? [])
    .filter(
      (p: Part): p is Extract<Part, { kind: "text" }> => p.kind === "text"
    )
    .map((p) => p.text)
    .join("")
    .trim();
}

/** The fields recovered from a gateway-rendered `<turn>` wrapper. */
export interface ParsedTurn {
  from: string;
  /** Slack user id, as rendered. */
  id: string;
  channel: string;
  /** ISO-8601 instant. */
  at: string;
  /** The raw inner body. */
  body: string;
}

const TURN_TAG_RE = /^<turn\b([^>]*)>([\s\S]*)<\/turn>$/;
const ATTR_RE = /(\w+)="([^"]*)"/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw)) !== null) out[m[1]] = m[2];
  return out;
}

const ATTR_UNESCAPES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"'
};

/** Reverse the gateway's attribute escaping — single pass so `&amp;` round-trips. */
function unescAttr(value: string): string {
  return value.replace(/&(amp|lt|gt|quot);/g, (_, e) => ATTR_UNESCAPES[e]);
}

/**
 * Recover the structured provenance from a gateway-authored turn. Returns null
 * for any text that isn't a `<turn>` wrapper (plain messages, assistant replies),
 * so callers can treat the provenance as optional.
 */
export function parseTurn(text: string): ParsedTurn | null {
  const m = TURN_TAG_RE.exec(text);
  if (!m) return null;
  const attrs = parseAttrs(m[1]);
  if (!attrs.from || !attrs.id || !attrs.channel || !attrs.at) return null;
  return {
    from: unescAttr(attrs.from),
    id: unescAttr(attrs.id),
    channel: unescAttr(attrs.channel),
    at: unescAttr(attrs.at),
    body: m[2]
  };
}

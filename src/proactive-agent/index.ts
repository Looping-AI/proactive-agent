import { Agent } from "agents";
import type { GatewayIdentity } from "@/a2a/verify";
import { createModelPair, embedTexts, type ModelPair } from "@/agent/model";
import { callerContext, soulPrompt } from "@/agent/prompt";
import { buildTools } from "@/agent/tools";
import { archiveMessages } from "@/agent/recall";
import { runTurn } from "@/agent/loop";
import { buildAgentSession, type SessionLike } from "@/agent/session";
import {
  COMPACT_AFTER_TOKENS,
  MEMORY_DESCRIPTION,
  MEMORY_MAX_TOKENS
} from "@/config";

/** Reply the DO returns when an unexpected (non-transient) failure aborts a turn. */
const UNEXPECTED_REPLY =
  "Sorry, I hit an unexpected error handling that request. Please try again, " +
  "and check the agent's logs if it keeps happening.";

/**
 * The agent runtime as a Durable Object: one instance per calling gateway-agent
 * (keyed by the verified JWT `identity.key`), each owning **one continuous
 * Session** — durable history + a self-edited `memory` block, backed by
 * `this.sql`. All of a caller's turns (any channel/thread) accumulate into this
 * single conversation.
 *
 * The outer Worker reaches this DO with a single native Cloudflare RPC call —
 * `stub.converse(text, identity)` — not HTTP: the DO is a private implementation
 * detail of the Worker, never exposed over the network, so it needs no internal
 * A2A/JSON-RPC layer of its own.
 *
 * History is compacted automatically once it grows past {@link COMPACT_AFTER_TOKENS}
 * (the Sessions `compactAfter` mechanism). (Phase 5 will also serve a self-generated
 * avatar from here.)
 */
export class ProactiveAgent extends Agent<Env> {
  private session?: SessionLike;
  private models?: ModelPair;

  private modelPair(): ModelPair {
    return (this.models ??= createModelPair(this.env));
  }

  /**
   * The one continuous Session for this caller (rebuilt from `this.sql` after
   * eviction). Takes the verified identity so compaction can archive the
   * displaced messages into this instance's Vectorize namespace (episodic
   * recall). Memoized — `identity` is constant for the DO's life (the DO is
   * keyed 1:1 by `identity.key`).
   */
  getSession(identity: GatewayIdentity): SessionLike {
    const namespace = recallNamespace(identity);
    return (this.session ??= buildAgentSession(
      this,
      this.modelPair().primary(),
      {
        soul: () => soulPrompt(),
        memoryDescription: MEMORY_DESCRIPTION,
        memoryMaxTokens: MEMORY_MAX_TOKENS,
        compactAfterTokens: COMPACT_AFTER_TOKENS,
        // Episodic recall: embed the messages each compaction displaces into
        // this instance's Vectorize namespace. Best-effort — the wrapper
        // swallows failures so compaction still shortens history.
        onArchive: (messages) =>
          archiveMessages(this.env.VECTORIZE, namespace, messages, (texts) =>
            embedTexts(this.env, texts)
          )
      }
    ));
  }

  /**
   * Answer one turn for this caller and return the reply text. Runs the
   * Workers-AI tool loop over the continuous Session (append → generate →
   * persist).
   *
   * The turn loop {@link runTurn} never throws — transient/unexpected failures
   * resolve to a friendly reply — so this method rejects only on a genuine
   * RPC/transport fault, keeping the Worker-side caller trivial.
   */
  async converse(text: string, identity: GatewayIdentity): Promise<string> {
    const session = this.getSession(identity);
    // Gate the `recall` tool on "has compacted at least once" — nothing is
    // archived (and the tool would only return empties) before the first
    // compaction.
    const hasArchive = (await session.getCompactions()).length > 0;
    return await runTurn({
      session,
      text,
      systemSuffix: callerContext(identity),
      tools: buildTools(identity, {
        index: this.env.VECTORIZE,
        namespace: recallNamespace(identity),
        embed: (texts) => embedTexts(this.env, texts),
        hasArchive
      }),
      models: this.modelPair(),
      unexpectedReply: UNEXPECTED_REPLY
    });
  }
}

/**
 * The Vectorize namespace isolating this instance's episodic archive. Bound in
 * code from the verified `identity.key` (e.g. `custom:7:analytics`) — never from
 * model input — so one caller can never read another's history. The DO is keyed
 * 1:1 by this same key, and the executor refuses a token without it (400), so it
 * is always present here.
 */
function recallNamespace(identity: GatewayIdentity): string {
  if (!identity.key) {
    throw new Error("identity.key is required for namespace isolation");
  }
  return identity.key;
}

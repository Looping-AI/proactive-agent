# Plan: Grow `proactive-agent` from Echo → full-fledged A2A agent

## Context

`proactive-agent` is a **stateful proactive A2A agent** for
[looping-gateway](https://github.com/Looping-AI/looping-gateway), running on a
single **Cloudflare Worker** with a **`ProactiveAgent` Durable Object** runtime
(one instance per calling gateway-agent). Phases 1 & 2 are done: the agent
verifies the gateway JWT, maintains a durable per-caller Session (soul + memory +
compaction, backed by `this.sql`), and runs a Workers-AI tool loop with
placeholder `whoami` / `echo` tools. The outer Worker calls the DO via **native
Cloudflare RPC** (`stub.converse(text, identity)`) — no internal A2A / JSON-RPC
layer on the DO.

The remaining phases add episodic recall (Vectorize), real domain tools, and a
self-generated avatar, while keeping the existing zero-trust A2A contract
(signed card + gateway-JWT verification) untouched.

Work is split into incremental phases; each phase is a **separate future
session**. This document is the high-level map only — each phase gets its own
detailed plan when we start it.

**Decisions locked in (2026-07-01):**

- **Model backend:** Workers AI via AI Gateway (mirror admin's `model.ts`), primary + fallback.
- **Architecture:** migrate to a **Durable Object** (Agents-SDK `Agent` base) — required for Sessions + recall.
- **Domain tools:** deferred — ship the framework with placeholder/example tools; real tools come in a later session.
- **Avatar:** included as the final optional phase.

The admin agent's shared machinery (`src/agents/shared/*`, `model.ts`)
was the reference implementation for porting. It is **not** a dependency —
this repo re-implements the pieces it needs standalone (it has no `@/db`, no
gateway internals). (`base.ts` was removed from the gateway during its own
refactor and is no longer part of the reference.)

### Key mapping difference vs. admin

The admin agent runs _inside_ the gateway and gets its caller from dispatch
metadata (`metadata.user`, `adminWorkspaceId`). This agent is **remote**: the
gateway JWT only attests the **calling gateway-agent instance**
(`GatewayIdentity`: `key`, `name`, `kind`, `workspaceId` — see
[`src/a2a/verify.ts`](src/a2a/verify.ts)), never the Slack end user or their
roles — the gateway's `agent-jwt.ts` deliberately excludes `slackUserId`/
`displayName` from this claim so a remote agent can't read the full caller
auth context. The `<turn from=… id=… channel=… at=…>` provenance wrapper is
authored by the gateway and arrives **inside the message text** — this is the
only channel carrying the Slack speaker's identity, and it is unverified. This
agent _parses_ turns (for attribution + recall metadata) but never renders
them.

---

## Phase 1 — Real LLM tool loop (retire the echo) ✅ DONE

Replace `EchoExecutor` with a Workers-AI `generateText` tool loop so the agent
actually reasons and replies. **Stateless** at this stage (no persistence yet).

- Port a **model pair** (primary + fallback via `workers-ai-provider` + AI Gateway) — mirror `model.ts`.
- Port a **turn runner**: bounded multi-step loop (`stepCountIs`), primary→fallback on error, transient-error → friendly retry message — mirror `shared/loop.ts`.
- A **soul / system prompt** (identity + operating rules) that includes the verified caller context from the JWT, and awareness of the `<turn>` wrapper for multi-actor channels — mirror `shared/prompt.ts` + `messages.ts` (parse side only).
- 1–2 **placeholder tools** (e.g. `echo`/`whoami`) to prove tool-calling end to end.
- New deps: `ai`, `workers-ai-provider`. Wrangler: `AI` binding + AI Gateway id.
- **Outcome:** agent converses and can call a tool; no memory yet.

## Phase 2 — Durable state & memory (Sessions) ✅ DONE

The agent runtime is now a **Durable Object** (Agents-SDK `Agent` base); the outer
Worker verifies the JWT and dispatches the turn into it via native RPC, so each
caller gets SQLite-backed state.

- **DO runtime** ([`src/proactive-agent/index.ts`](src/proactive-agent/index.ts)): a plain `Agent<Env>` exposing one public RPC method, `converse(text, identity)`; `this.sql` backs Sessions. The Worker owns the single A2A JSON-RPC server ([`index.ts`](src/index.ts) + [`executor.ts`](src/a2a/executor.ts)) and reaches the DO with a native Cloudflare RPC call (`stub.converse(...)`), passing the **verified** identity as a typed argument — no internal HTTP/JSON-RPC layer on the DO (it's a private implementation detail of the Worker, not a network-reachable service).
- **Sessions** ([`session.ts`](src/agent/session.ts)): read-only `"soul"` block + writable `"memory"` scratchpad the model self-edits + history **compaction** summarized by the same model (`onArchive` seam left for Phase 3).
- **DO instance key = the verified JWT `identity.key`** (one instance per calling gateway-agent; **no fallback** — a token without `key` is refused, 400). Each DO holds **one continuous Session** across all the caller's channels/threads.
- **Compaction** fires on size (`compactAfter` — the Sessions `compactAfter` mechanism).
- New dep: `agents`. Wrangler: `ProactiveAgent` Durable Object binding + SQLite migration.
- **Outcome:** the agent remembers across turns and maintains durable facts per caller.

## Phase 3 — Episodic recall (Vectorize)

Give the agent memory beyond the live context window.

- Port **recall** (`shared/recall.ts`): archive compacted-away messages into **Vectorize** (embeddings), namespaced per DO instance, with `<turn>`-parsed metadata (author/channel/at).
- Port the single **`recall` tool** (`shared/recall-tool.ts`), gated on "has compacted at least once", namespace bound by the instance (never model input).
- Wrangler: `VECTORIZE` binding + embedding model id.
- **Outcome:** the agent can semantically recall older history that scrolled out of context.

## Phase 4 — Real domain tools + authorization

Turn the agent from "chat with memory" into one that does real work — the
analog of admin's `agents_*` / `workspace_*` registry tools.

- Design the actual tool set (**deferred — to be specified in that session**). Follow admin's shape: **consolidated read/write per domain** (no tool proliferation), discriminated-union `operation` for writes.
- **Authorization**: gate each tool per-call on the verified caller's identity/roles from the JWT (admin's `authorize()` + `deny()` pattern), independent of the advisory system-prompt context.
- Advertise the new skills in the **AgentCard `skills[]`** + [`manifest.ts`](src/agent/manifest.ts).
- **Outcome:** the agent performs authorized real actions, not just conversation.

## Phase 5 — Self-service avatar (optional polish)

Cosmetic parity with admin.

- Port **avatar generation** (`admin/avatar.ts`): Workers-AI image model (FLUX), decode to bytes.
- Store the icon in **DO storage** keyed by content hash, prune to last N, and serve it over HTTP (`/icons/…`) — mirror `admin/index.ts` `putIcon`/`fetch`.
- Add an **`avatar_regenerate` tool** and surface the icon URL on the AgentCard.
- Wrangler: image model id.
- **Outcome:** the agent owns and can regenerate its own Slack avatar.

---

## Cross-cutting (applies to every phase)

- **Preserve the A2A contract**: signed card ([`src/a2a/card.ts`](src/a2a/card.ts)), JWKS, and gateway-JWT verification ([`src/a2a/verify.ts`](src/a2a/verify.ts), [`canonical.ts`](src/a2a/canonical.ts)) stay intact — only the executor/serving path changes.
- **Update the manifest/card** capabilities as features land (`streaming`, `pushNotifications` are currently `false`).
- **Tests**: keep the pure tool/handler logic split from AI-SDK wiring so it unit-tests without an LLM (admin's pattern); extend `vitest` coverage each phase.
- **Docs**: update [`ARCHITECTURE.md`](ARCHITECTURE.md) + [`AGENTS.md`](AGENTS.md) each phase.

## Verification (per phase, end to end)

- `npm run check` (prettier + eslint + tsc) and `npm run test` stay green.
- `npm run dev` (wrangler) locally; drive the agent via an A2A JSON-RPC `POST`
  with a valid gateway JWT and confirm the new behavior (LLM reply → remembered
  fact across turns → recalled quote → tool action → regenerated avatar URL).
- Confirm the signed card + JWKS still verify from the gateway's side (registration path unchanged).

## Reference source (for porting)

- https://github.com/Looping-AI/looping-gateway/tree/main/src/agents/admin
- `looping-gateway/src/agents/`: `shared/{loop,session,recall,recall-tool,prompt,messages}.ts`,
  `model.ts`, and `admin/{executor,tools,prompt,avatar,index}.ts`.
  (`base.ts` was removed from the gateway during its own refactor; Phases 1 & 2 have been ported from the remaining files.)

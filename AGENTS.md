# AGENTS.md

Guidance for coding agents working in this repo. Keep it accurate — update it when the build, layout, or contract below changes.

## What this is

A deployable **reference remote (custom) A2A agent** for [looping-gateway](https://github.com/Looping-AI/looping-gateway), running as a single **Cloudflare Worker**. It demonstrates the zero-shared-secrets trust contract a third party must implement to be registered and routed to by the gateway. All trust flows through asymmetric **Ed25519 / EdDSA** signatures over public JWKS — there are no symmetric secrets in either direction.

Once the caller is verified, the Worker routes the call into a **`ProactiveAgent` Durable Object** — one instance per calling gateway-agent (keyed by the verified `identity.key`) — which answers with a Workers-AI tool loop over the caller's **durable Session** (one continuous conversation + a self-edited `memory` block, backed by `this.sql`), compacting history on size. See the "Agent runtime" section of [ARCHITECTURE.md](ARCHITECTURE.md). It ships with placeholder `whoami` / `echo` tools; episodic recall and real domain tools are later phases (see [PLAN.md](PLAN.md)). The enduring value is the zero-trust _contract_, which is independent of the agent's behavior.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the full trust model and sequence diagrams, and [README.md](README.md) for setup/deploy/registration.

## Commands

```sh
npm install            # install deps
npm run dev            # wrangler dev (local Worker); press `t` for a quick tunnel
npm run test           # vitest run (whole suite in the Workers runtime via one cloudflareTest pool; hermetic — no network)
npm run test:watch     # vitest watch
npm run check          # wrangler types --check && prettier --check && eslint && tsc (src) && tsc (test)  ← CI + pre-commit gate
npm run lint           # eslint only
npm run format         # prettier --write .
npm run types          # regenerate worker-configuration.d.ts (wrangler types) — then commit it
npm run keygen <kid>   # generate an Ed25519 private JWK for A2A_SIGNING_KEY
```

`npm run check` is the source of truth: it runs in CI ([.github/workflows/test.yml](.github/workflows/test.yml)) and as the husky `pre-commit` hook. Run `npm run check && npm run test` before committing — the commit will be rejected otherwise.

**Types come from a committed, generated [worker-configuration.d.ts](worker-configuration.d.ts)** — `wrangler types` produces full _runtime_ types tailored to `wrangler.jsonc`'s compat date / flags / bindings. This file (plus `@types/node`, because `nodejs_compat` is on) is the source of the ambient Workers globals (`Ai`, `DurableObjectNamespace`, `ExportedHandler`, `Request`, …); it replaced `@cloudflare/workers-types`. It's **committed to git** and referenced from `tsconfig.json` / `test/tsconfig.json` `types`. `npm run check` leads with `wrangler types --check` as a drift guard, so after any `wrangler.jsonc` binding change or a wrangler/workerd bump (incl. dependabot's cloudflare group), run `npm run types` and **commit the regenerated file** or the gate fails.

## Layout

| Path                                                               | Role                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/index.ts](src/index.ts)                                       | Worker entry. Serves JWKS / AgentCard; verifies the gateway JWT; runs the A2A JSON-RPC server for the inbound call; `A2AExecutor` routes each verified turn into the caller's DO via native Cloudflare RPC. |
| [src/proactive-agent/index.ts](src/proactive-agent/index.ts)       | `ProactiveAgent` DO — owns the caller's Session; `converse()` RPC method answers turns.                                                                                                                     |
| [src/agent/session.ts](src/agent/session.ts)                       | The continuous Session (soul + memory + compaction) + `archivingCompaction`.                                                                                                                                |
| [src/a2a/executor.ts](src/a2a/executor.ts)                         | `A2AExecutor` — A2A executor: extracts the inbound text, dispatches to the caller's DO via native Cloudflare RPC (`stub.converse()`), and publishes the reply.                                              |
| [src/agent/loop.ts](src/agent/loop.ts)                             | `runTurn` — Session turn runner: append → `generateText` loop → persist → return; primary → fallback, transient handling.                                                                                   |
| [src/agent/model.ts](src/agent/model.ts)                           | Workers-AI primary/fallback model pair (via AI Gateway); `ModelOverrides` test hook.                                                                                                                        |
| [src/agent/prompt.ts](src/agent/prompt.ts)                         | Soul (frozen identity + rules) + per-request `callerContext` from the verified JWT.                                                                                                                         |
| [src/agent/tools.ts](src/agent/tools.ts)                           | Placeholder `whoami` / `echo` tools — pure handlers split from AI-SDK `tool()` wiring.                                                                                                                      |
| [src/a2a/inbound.ts](src/a2a/inbound.ts)                           | Inbound A2A message → text (`textOf`) — the one place touching the `@a2a-js/sdk` message shape.                                                                                                             |
| [src/agent/history.ts](src/agent/history.ts)                       | `<turn>` provenance parsing (`parseTurn`) + Session-history message glue (no A2A types).                                                                                                                    |
| [src/config.ts](src/config.ts)                                     | Model ids, AI Gateway slug, loop bound, and Session/compaction tuning (constants).                                                                                                                          |
| [src/proactive-agent/manifest.ts](src/proactive-agent/manifest.ts) | AgentCard manifest definition (identity + skills).                                                                                                                                                          |
| [src/a2a/card.ts](src/a2a/card.ts)                                 | Build + EdDSA-sign the AgentCard; derive the public card-signing JWKS.                                                                                                                                      |
| [src/a2a/canonical.ts](src/a2a/canonical.ts)                       | Canonical-JSON serialization used for the card signature. **Mirrors the gateway — see below.**                                                                                                              |
| [src/a2a/verify.ts](src/a2a/verify.ts)                             | Verify the inbound gateway identity JWT (sig + `iss` + `aud` + `exp` + `jku` origin).                                                                                                                       |
| [scripts/generate-keys.mjs](scripts/generate-keys.mjs)             | Ed25519 JWK keypair generator.                                                                                                                                                                              |
| [test/](test/)                                                     | Vitest specs + [test/fixtures.ts](test/fixtures.ts) (fixed test keys, `makeGatewayToken`).                                                                                                                  |
| [wrangler.jsonc](wrangler.jsonc)                                   | Worker config: `AI` binding + `ProactiveAgent` Durable Object (SQLite migration). Secrets live outside it.                                                                                                  |

## Non-negotiable constraints

These are the things that silently break the contract or the trust model. Treat them as invariants.

1. **`src/a2a/canonical.ts` must stay byte-for-byte identical to the gateway's** `src/a2a/card-verify.ts` canonicalizer (keys sorted recursively ascending, `JSON.stringify` no whitespace, `signatures` excluded, base64url no padding). The gateway recomputes the signed payload independently; any deviation makes signatures fail to verify. **If you change one, change both.** Don't "improve" the serialization.

2. **Algorithm is `EdDSA` (Ed25519) everywhere** — card signing, gateway JWT verification, key generation. Reject/forbid anything else. The constant `ALG = "EdDSA"` appears in `src/a2a/card.ts` and `src/a2a/verify.ts`; keep them in lockstep.

3. **Never weaken the JWT verification in `src/a2a/verify.ts`.** It enforces, in order: `jku` header present → `jku` origin ∈ `GATEWAY_ORIGINS` → `iss` origin === `jku` origin → `jwtVerify` with `issuer`/`audience`/`algorithms`. The `jku`-origin allowlist and the `iss`===`jku` check prevent key-injection and cross-gateway impersonation. Do not skip a check, widen the allowlist to wildcards, or fetch a `jku` before validating its origin.

4. **Zero shared secrets.** Only public JWKS cross the boundary. The single private key (`A2A_SIGNING_KEY`) never leaves the Worker; only its public half is served at `/.well-known/jwks.json`. Never log, echo, or commit a private JWK or the `d` field.

5. **`GATEWAY_ORIGINS` (Worker secret) must match the deployed gateway's `GATEWAY_ORIGIN`.** It's a JSON array string, e.g. `["https://gw.example.com"]`. It validates both the JWT `jku` and `iss`.

## Runtime & style

- **Cloudflare Workers runtime**, not Node. `nodejs_compat` is on, but prefer Web APIs (`crypto`, `fetch`, `Response.json`, `TextEncoder`). Crypto goes through [`jose`](https://github.com/panva/jose). `@types/node` is installed (for tooling/config like `vitest.config.ts`) — it will happily type Node built-ins that aren't in the Workers runtime, so it won't catch a Node API creeping into Worker code; that's on you.
- The agent runtime is a **Durable Object** on the [`agents`](https://github.com/cloudflare/agents) SDK `Agent` base. Reach it only via the Worker's DO stub with **native Cloudflare RPC** (`await stub.converse(text, identity)`) — never `routeAgentRequest`, and **never re-implement an internal HTTP/JSON-RPC layer on top of the DO**: it's a private implementation detail of this Worker, not a network-reachable service, so the one real A2A server lives in the Worker (`src/index.ts`) and the DO just exposes plain async methods. Use `this.sql` for the Session — **do not override the DO `alarm()`** (the `Agent` base owns it). Sessions live under `agents/experimental/memory/*`.
- TypeScript is `strict`. ESLint forbids `@typescript-eslint/no-explicit-any` and `@typescript-eslint/no-deprecated` (both `error`). Prefix intentionally-unused vars with `_`.
- Prettier with `trailingComma: "none"`. Run `npm run format`; don't hand-format.
- Module entry is `satisfies ExportedHandler<Env>` and re-exports the `ProactiveAgent` DO class (Cloudflare resolves the `class_name` from the entry exports); bindings and secrets are typed via the `Env` interface in [worker-configuration.d.ts](worker-configuration.d.ts) (generated; includes `AI`, `ProactiveAgent`, `A2A_SIGNING_KEY`, `GATEWAY_ORIGINS`).

## Tests

- The **whole suite runs in the Workers runtime** (workerd via miniflare) through a **single `cloudflareTest()` pool** (config: [vitest.config.ts](vitest.config.ts)). The plugin registers the `cloudflare:test` virtual module (→ `env`, `runInDurableObject`, `runDurableObjectAlarm`, `introspectWorkflow`) and reads **`wrangler.jsonc` directly** (`wrangler: { configPath }`), so new bindings added there (e.g. a future `VECTORIZE`) are picked up automatically — only the two secrets kept out of `wrangler.jsonc` are supplied inline. **`remoteBindings: false` is passed explicitly** (not left default): the `AI` binding otherwise makes every test file eagerly open a remote connection at startup (~15-20s + a teardown hang). Three tiers:
  - _Agent runtime_ (`test/agent/**`): drive `runTurn` / prompt / tools / messages / Session helpers against an **injected mock model** ([test/agent/mock-model.ts](test/agent/mock-model.ts)) + a fake `SessionLike`, so they unit-test without a real Session or `AI`. Error-path tests inject failure by **throwing synchronously from the model factory** (`primary: () => { throw }` in `loop.spec.ts`) — _not_ by passing a model whose `doGenerate` rejects into `generateText`, which leaks an unhandled rejection through the AI SDK telemetry span that workerd flags as a failure.
  - _Entrypoint + auth_ (`test/index.spec.ts`, `test/a2a/**`): drive the outer Worker's own logic. `index.spec.ts` injects a **fake `ProactiveAgent` namespace** (a stub exposing `.converse()`) to assert routing (DO keyed by `identity.key`, forwarded text + identity) and `A2AExecutor`'s glue behavior (publishes the DO's reply; still returns a friendly reply when the DO call fails) — without a real DO. The thin `A2AExecutor` has no spec of its own; this is its coverage.
  - _Real-DO integration_ (`test/proactive-agent/proactive-agent.spec.ts`): drive the **real** `ProactiveAgent` DO via `env.ProactiveAgent` — turns through `stub.converse(...)`, internals via `runInDurableObject` — real SQLite-backed Session. Complementary to `index.spec.ts`, not redundant. `env.AI.run()` throws "needs to be run remotely" immediately (no network), so turns take the same graceful error path as production without a model.
- The suite is **hermetic**: `MockAgent` with `disableNetConnect()` intercepts the gateway JWKS fetch; the LLM is either a mock model ([test/agent/mock-model.ts](test/agent/mock-model.ts)) or the fail-fast local `AI` binding. Don't add real network/inference calls in tests.
- **Split pure logic from AI-SDK / DO wiring** so it unit-tests without an LLM or a real Session (e.g. `whoami`/`echo` handlers, `parseTurn`, `archivingCompaction`); drive `runTurn` with `mockModel(...)` (or a `ModelPair` that throws from its factory for error paths), the `ModelOverrides` hook, and a fake `SessionLike`; drive `A2AExecutor` with a fake DO stub (`.converse()`).
- Test keys and `makeGatewayToken(...)` live in [test/fixtures.ts](test/fixtures.ts). Build gateway tokens through that helper so headers/claims stay consistent.
- When adding a route or verification branch, cover it with both an accept and a reject case (mirror the existing `test/a2a/verify.spec.ts` / `test/index.spec.ts` style).

## Secrets

- `A2A_SIGNING_KEY` — Ed25519 private JWK (must include `kid`). Locally in `.dev.vars` (gitignored; see [.dev.vars.example](.dev.vars.example)); in prod via `wrangler secret put A2A_SIGNING_KEY`. Generate with `npm run keygen <kid>`. Never commit it.
- `GATEWAY_ORIGINS` — JSON array of trusted gateway origins, e.g. `["https://gw.example.com"]`. Not sensitive, but kept in `.dev.vars` locally and `wrangler secret put GATEWAY_ORIGINS` in prod (rather than `wrangler.jsonc` vars) so it can be changed per-deploy without a code change.

## Note on `.agents/skills/`

That directory holds vendored Cloudflare skill packs (tracked in `skills-lock.json`) — reference material, not application code. Don't edit those files by hand.

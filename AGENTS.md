# AGENTS.md

Guidance for coding agents working in this repo. Keep it accurate — update it when the build, layout, or contract below changes.

## What this is

A deployable **reference remote (custom) A2A agent** for [looping-gateway](https://github.com/Looping-AI/looping-gateway), running as a single **Cloudflare Worker**. It demonstrates the zero-shared-secrets trust contract a third party must implement to be registered and routed to by the gateway. All trust flows through asymmetric **Ed25519 / EdDSA** signatures over public JWKS — there are no symmetric secrets in either direction.

Once the caller is verified, the agent answers with a **stateless Workers-AI tool loop** (primary + fallback model via AI Gateway) — see the "Agent runtime" section of [ARCHITECTURE.md](ARCHITECTURE.md). It ships with placeholder `whoami` / `echo` tools; real domain tools, memory, and recall are later phases (see [PLAN.md](PLAN.md)). The enduring value is the zero-trust _contract_, which is independent of the agent's behavior.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the full trust model and sequence diagrams, and [README.md](README.md) for setup/deploy/registration.

## Commands

```sh
npm install            # install deps
npm run dev            # wrangler dev (local Worker); press `t` for a quick tunnel
npm run test           # vitest run (node project for the agent runtime + workers project for the entrypoint; hermetic — no network)
npm run test:watch     # vitest watch
npm run check          # prettier --check && eslint && tsc (src) && tsc (test)  ← CI + pre-commit gate
npm run lint           # eslint only
npm run format         # prettier --write .
npm run types          # regenerate env.d.ts from wrangler bindings
npm run keygen <kid>   # generate an Ed25519 private JWK for A2A_SIGNING_KEY
```

`npm run check` is the source of truth: it runs in CI ([.github/workflows/test.yml](.github/workflows/test.yml)) and as the husky `pre-commit` hook. Run `npm run check && npm run test` before committing — the commit will be rejected otherwise.

## Layout

| Path                                                   | Role                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [src/index.ts](src/index.ts)                           | Worker entry. Routes JWKS / AgentCard / JSON-RPC; verifies the gateway JWT.                    |
| [src/env.ts](src/env.ts)                               | `Env` interface (bindings + vars): `A2A_SIGNING_KEY`, `GATEWAY_ORIGINS`, `AI`.                 |
| [src/agent/executor.ts](src/agent/executor.ts)         | `LlmExecutor` — wires the model pair, prompt, and tools into the turn loop.                    |
| [src/agent/loop.ts](src/agent/loop.ts)                 | Stateless turn runner: `generateText` loop, primary → fallback, transient handling.            |
| [src/agent/model.ts](src/agent/model.ts)               | Workers-AI primary/fallback model pair (via AI Gateway); `ModelOverrides` test hook.           |
| [src/agent/prompt.ts](src/agent/prompt.ts)             | Soul (frozen identity + rules) + per-request `callerContext` from the verified JWT.            |
| [src/agent/tools.ts](src/agent/tools.ts)               | Placeholder `whoami` / `echo` tools — pure handlers split from AI-SDK `tool()` wiring.         |
| [src/agent/messages.ts](src/agent/messages.ts)         | A2A text extraction (`textOf`) + `<turn>` provenance parsing (`parseTurn`).                    |
| [src/agent/config.ts](src/agent/config.ts)             | Model ids, AI Gateway slug, and the loop step bound (constants).                               |
| [src/agent/manifest.ts](src/agent/manifest.ts)         | AgentCard manifest definition (identity + skills).                                             |
| [src/auth/card.ts](src/auth/card.ts)                   | Build + EdDSA-sign the AgentCard; derive the public card-signing JWKS.                         |
| [src/auth/canonical.ts](src/auth/canonical.ts)         | Canonical-JSON serialization used for the card signature. **Mirrors the gateway — see below.** |
| [src/auth/verify.ts](src/auth/verify.ts)               | Verify the inbound gateway identity JWT (sig + `iss` + `aud` + `exp` + `jku` origin).          |
| [scripts/generate-keys.mjs](scripts/generate-keys.mjs) | Ed25519 JWK keypair generator.                                                                 |
| [test/](test/)                                         | Vitest specs + [test/fixtures.ts](test/fixtures.ts) (fixed test keys, `makeGatewayToken`).     |
| [wrangler.jsonc](wrangler.jsonc)                       | Worker config: `AI` binding + `GATEWAY_ORIGINS` var.                                           |

## Non-negotiable constraints

These are the things that silently break the contract or the trust model. Treat them as invariants.

1. **`src/auth/canonical.ts` must stay byte-for-byte identical to the gateway's** `src/a2a/card-verify.ts` canonicalizer (keys sorted recursively ascending, `JSON.stringify` no whitespace, `signatures` excluded, base64url no padding). The gateway recomputes the signed payload independently; any deviation makes signatures fail to verify. **If you change one, change both.** Don't "improve" the serialization.

2. **Algorithm is `EdDSA` (Ed25519) everywhere** — card signing, gateway JWT verification, key generation. Reject/forbid anything else. The constant `ALG = "EdDSA"` appears in `src/auth/card.ts` and `src/auth/verify.ts`; keep them in lockstep.

3. **Never weaken the JWT verification in `src/auth/verify.ts`.** It enforces, in order: `jku` header present → `jku` origin ∈ `GATEWAY_ORIGINS` → `iss` origin === `jku` origin → `jwtVerify` with `issuer`/`audience`/`algorithms`. The `jku`-origin allowlist and the `iss`===`jku` check prevent key-injection and cross-gateway impersonation. Do not skip a check, widen the allowlist to wildcards, or fetch a `jku` before validating its origin.

4. **Zero shared secrets.** Only public JWKS cross the boundary. The single private key (`A2A_SIGNING_KEY`) never leaves the Worker; only its public half is served at `/.well-known/jwks.json`. Never log, echo, or commit a private JWK or the `d` field.

5. **`GATEWAY_ORIGINS` (Worker var) must match the deployed gateway's `GATEWAY_ORIGIN`.** It's a JSON array string, e.g. `["https://gw.example.com"]`. It validates both the JWT `jku` and `iss`.

## Runtime & style

- **Cloudflare Workers runtime**, not Node. `nodejs_compat` is on, but prefer Web APIs (`crypto`, `fetch`, `Response.json`, `TextEncoder`). Crypto goes through [`jose`](https://github.com/panva/jose).
- TypeScript is `strict`. ESLint forbids `@typescript-eslint/no-explicit-any` and `@typescript-eslint/no-deprecated` (both `error`). Prefix intentionally-unused vars with `_`.
- Prettier with `trailingComma: "none"`. Run `npm run format`; don't hand-format.
- Module entry is `satisfies ExportedHandler<Env>`; bindings are typed via the `Env` interface in [src/env.ts](src/env.ts) (mirrored by `wrangler.jsonc` bindings/vars).

## Tests

- Two vitest projects (config: [vitest.config.ts](vitest.config.ts)):
  - **`workers`** — the entrypoint + auth specs (`test/index.spec.ts`, `test/auth/**`) run inside the Workers runtime via `@cloudflare/vitest-pool-workers`.
  - **`node`** — the agent-runtime specs (`test/agent/**`) run under Node. The tool loop is pure JS driven against an **injected mock model**, and workerd spuriously flags the mock's rejected `doGenerate` as an unhandled rejection.
- The suite is **hermetic**: `MockAgent` with `disableNetConnect()` intercepts the gateway JWKS fetch; the LLM is a mock model ([test/agent/mock-model.ts](test/agent/mock-model.ts)) so no `AI` binding or network is used. Don't add real network/inference calls in tests.
- **Split pure logic from AI-SDK wiring** so it unit-tests without an LLM (e.g. `whoami`/`echo` handlers, `parseTurn`, `callerContext`); drive the loop/executor with `mockModel(...)` / `throwingModel(...)` and the `ModelOverrides` constructor hook.
- Test keys and `makeGatewayToken(...)` live in [test/fixtures.ts](test/fixtures.ts). Build gateway tokens through that helper so headers/claims stay consistent.
- When adding a route or verification branch, cover it with both an accept and a reject case (mirror the existing `test/auth/verify.spec.ts` / `test/index.spec.ts` style).

## Secrets

- `A2A_SIGNING_KEY` — Ed25519 private JWK (must include `kid`). Locally in `.dev.vars` (gitignored; see [.dev.vars.example](.dev.vars.example)); in prod via `wrangler secret put A2A_SIGNING_KEY`. Generate with `npm run keygen <kid>`. Never commit it.

## Note on `.agents/skills/`

That directory holds vendored Cloudflare skill packs (tracked in `skills-lock.json`) — reference material, not application code. Don't edit those files by hand.

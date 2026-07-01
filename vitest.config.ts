import { defineConfig } from "vitest/config";
import { cloudflarePool } from "@cloudflare/vitest-pool-workers";
import { resolve } from "path";
import { MockAgent } from "undici";
import {
  GATEWAY_ORIGIN,
  TEST_AGENT_PRIVATE_JWK,
  gatewayPublicJwks
} from "./test/fixtures";

// Intercept the gateway's JWKS fetch (triggered by createRemoteJWKSet during
// token verification) so tests never hit the network. disableNetConnect makes
// any unmocked outbound request throw, keeping the suite hermetic.
const fetchMock = new MockAgent();
fetchMock.disableNetConnect();
fetchMock
  .get(GATEWAY_ORIGIN)
  .intercept({ path: "/.well-known/jwks.json" })
  .reply(200, gatewayPublicJwks(), {
    headers: { "content-type": "application/json" }
  })
  .persist();

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") }
  },
  test: {
    projects: [
      // Agent runtime (LLM tool loop, prompt, tools, messages): pure JS that
      // drives the AI SDK against an injected mock model — no workerd needed.
      // (workerd's promise tracking spuriously flags the mock's rejected
      // `doGenerate` as an unhandled rejection, so these run under Node.)
      {
        extends: true,
        test: {
          name: "node",
          include: ["test/agent/**/*.spec.ts"],
          environment: "node"
        }
      },
      // Worker entrypoint + zero-trust auth: exercise the real fetch handler in
      // workerd via miniflare, with the gateway JWKS fetch mocked.
      {
        extends: true,
        test: {
          name: "workers",
          include: ["test/**/*.spec.ts"],
          exclude: ["test/agent/**"],
          pool: cloudflarePool({
            main: "./src/index.ts",
            // Inline the compat settings instead of reading wrangler.jsonc so the
            // pool doesn't provision the real `AI` binding — it forces a remote
            // connection (and a slow teardown) that these tests never use (the
            // entrypoint test supplies its own env; auth tests don't touch AI).
            miniflare: {
              compatibilityDate: "2026-03-02",
              compatibilityFlags: ["nodejs_compat"],
              fetchMock,
              bindings: {
                A2A_SIGNING_KEY: JSON.stringify(TEST_AGENT_PRIVATE_JWK),
                GATEWAY_ORIGINS: JSON.stringify([GATEWAY_ORIGIN])
              }
            }
          })
        }
      }
    ]
  }
});

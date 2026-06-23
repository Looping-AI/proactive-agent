import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler
} from "@a2a-js/sdk/server";
import {
  buildBaseCard,
  parsePrivateJwk,
  publicCardJwks,
  signCard
} from "./auth/card";
import {
  GatewayAuthError,
  bearerToken,
  verifyGatewayToken,
  type GatewayIdentity
} from "./auth/verify";
import { EchoExecutor } from "./agent/executor";

/**
 * Reference remote A2A agent for looping-gateway.
 *
 * Demonstrates the full zero-trust, no-shared-secrets contract a third-party
 * custom agent must implement:
 *
 *  1. Publish the card-signing **public** JWKS at the card's `jku`.
 *  2. Serve a **signed** AgentCard at `…/.well-known/agent-card.json` so the
 *     gateway can verify+pin the agent's identity at registration ("G knows R").
 *  3. **Verify the gateway's identity JWT** on every JSON-RPC call against the
 *     gateway's public JWKS ("R knows G"), then echo the caller's message.
 *
 * No secret is ever shared between the gateway and this agent — trust flows
 * entirely on the domains and through asymmetric (Ed25519) signatures over public JWKS.
 */

interface Env {
  /** Ed25519 private JWK (with `kid`) used to sign this agent's AgentCard. */
  A2A_SIGNING_KEY: string;
  /** JSON array of trusted gateway origins, e.g. `["https://gw.example.com"]`. */
  GATEWAY_ORIGINS: string;
}

/** Path serving this agent's card-signing public JWKS (the card's `jku`). */
const JWKS_PATH = "/.well-known/jwks.json";

function unauthorized(reason: string): Response {
  return new Response(`unauthorized: ${reason}`, {
    status: 401,
    headers: { "www-authenticate": 'Bearer error="invalid_token"' }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    const privateJwk = parsePrivateJwk(env.A2A_SIGNING_KEY);

    // (1) Card-signing public JWKS — resolves the card's `jku` for the gateway.
    if (request.method === "GET" && url.pathname === JWKS_PATH) {
      return Response.json(publicCardJwks(privateJwk), {
        headers: { "cache-control": "public, max-age=3600" }
      });
    }

    // (2) Signed AgentCard discovery.
    if (request.method === "GET" && url.pathname.endsWith(AGENT_CARD_PATH)) {
      const card = await signCard(buildBaseCard(origin), {
        privateJwk,
        jku: `${origin}${JWKS_PATH}`
      });
      return Response.json(card);
    }

    // (3) A2A JSON-RPC — gateway-authenticated only.
    if (request.method === "POST") {
      const token = bearerToken(request);
      if (!token) return unauthorized("missing gateway bearer token");

      let identity: GatewayIdentity;
      try {
        ({ identity } = await verifyGatewayToken(token, {
          allowedOrigins: JSON.parse(env.GATEWAY_ORIGINS) as string[],
          audience: origin
        }));
      } catch (err) {
        const message =
          err instanceof GatewayAuthError ? err.message : "verification failed";
        return unauthorized(message);
      }

      const body = await request.json();
      const handler = new DefaultRequestHandler(
        buildBaseCard(origin),
        new InMemoryTaskStore(),
        new EchoExecutor(identity)
      );
      const rpc = new JsonRpcTransportHandler(handler);
      const result = await rpc.handle(body);

      // We don't advertise streaming; reject async generators outright.
      if (Symbol.asyncIterator in (result as object)) {
        return new Response("streaming not supported", { status: 501 });
      }
      return Response.json(result);
    }

    return new Response("not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;

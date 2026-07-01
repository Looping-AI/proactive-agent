import { importJWK, SignJWT, type JWK } from "jose";

/** The gateway origin used in all tests. Must match vitest.config.ts and the MockAgent setup. */
export const GATEWAY_ORIGIN = "https://gateway.test";

/** Agent origin matching `url.origin` for requests to `http://localhost`. */
export const AGENT_ORIGIN = "http://localhost";

/** Fixed Ed25519 private JWK used as A2A_SIGNING_KEY in tests. */
export const TEST_AGENT_PRIVATE_JWK: JWK & { kid: string } = {
  crv: "Ed25519",
  d: "sbR9EgZV1zUY-K6ENkvSLY8c8Q9kJ9NnxsXc4GVx_1g",
  x: "1dXrUHeE89GBnZbd7MjzJK-3Xvu7khZCK9ZrQauZQ6s",
  kty: "OKP",
  kid: "test-agent-key-1"
};

/** Fixed Ed25519 private JWK for signing gateway JWTs in tests. */
export const TEST_GATEWAY_PRIVATE_JWK: JWK & { kid: string } = {
  crv: "Ed25519",
  d: "OVKcn3LDH-qybNIdUbr7T9wbmlxNk2maU4_nILbaLKY",
  x: "jYiAbquXL6db7RihLvp2nsp1ShAolDI0tGOjuwsZVnI",
  kty: "OKP",
  kid: "test-gw-key-1"
};

/** Public JWKS the gateway would serve at its `jku` (the private key minus `d`). */
export function gatewayPublicJwks(): string {
  const { d: _d, ...pub } = TEST_GATEWAY_PRIVATE_JWK;
  return JSON.stringify({ keys: [{ ...pub, use: "sig", alg: "EdDSA" }] });
}

export interface GatewayTokenOptions {
  audience?: string;
  issuer?: string;
  /** Relative string ("5m"), absolute epoch seconds, or Date. Past values expire the token. */
  expiresIn?: string | number | Date;
  identity?: Record<string, unknown>;
}

/**
 * Sign a short-lived EdDSA gateway JWT using the test gateway key.
 * The `jku` header points to the mock JWKS served by vitest.config.ts.
 */
export async function makeGatewayToken(
  options: GatewayTokenOptions = {}
): Promise<string> {
  const privateKey = await importJWK(TEST_GATEWAY_PRIVATE_JWK, "EdDSA");
  return new SignJWT({
    "https://looping.ai/identity": options.identity ?? {
      key: "custom:1:test-agent",
      name: "Test Agent",
      kind: "custom",
      workspaceId: 1
    }
  })
    .setProtectedHeader({
      alg: "EdDSA",
      kid: TEST_GATEWAY_PRIVATE_JWK.kid,
      jku: `${GATEWAY_ORIGIN}/.well-known/jwks.json`
    })
    .setIssuer(options.issuer ?? GATEWAY_ORIGIN)
    .setAudience(options.audience ?? AGENT_ORIGIN)
    .setExpirationTime(options.expiresIn ?? "5m")
    .sign(privateKey);
}

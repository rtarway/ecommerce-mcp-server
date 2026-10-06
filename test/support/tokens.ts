import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";

export const ISSUER = "http://localhost:8080/realms/mcp";
export const AUDIENCE = "http://localhost:8000/mcp";

export interface TestIdp {
  keySet: JWTVerifyGetKey;
  sign(claims?: Record<string, unknown>, opts?: { issuer?: string; audience?: string; expiresIn?: string; key?: CryptoKey }): Promise<string>;
}

export async function createTestIdp(): Promise<TestIdp> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  return {
    keySet: createLocalJWKSet({ keys: [jwk] }),
    async sign(claims = {}, opts = {}) {
      return new SignJWT({
        sub: "user-123",
        preferred_username: "testuser",
        azp: "mcp-test-client",
        scope: "openid email",
        ...claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(opts.issuer ?? ISSUER)
        .setAudience(opts.audience ?? AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(opts.expiresIn ?? "5m")
        .sign(opts.key ?? privateKey);
    },
  };
}

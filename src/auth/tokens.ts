import { jwtVerify, type JWTVerifyGetKey } from "jose";

export interface Identity {
  subject: string;
  username: string;
  clientId: string | undefined;
  scopes: string[];
}

export class InvalidTokenError extends Error {}

export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match?.[1];
}

export interface VerifierConfig {
  issuer: string;
  audience: string;
  keySet: JWTVerifyGetKey;
}

export function createTokenVerifier({ issuer, audience, keySet }: VerifierConfig) {
  return async function verify(token: string): Promise<Identity> {
    try {
      const { payload } = await jwtVerify(token, keySet, { issuer, audience, algorithms: ["RS256", "ES256", "PS256"] });
      if (!payload.sub) throw new Error("token has no subject");
      const username = typeof payload.preferred_username === "string" ? payload.preferred_username : payload.sub;
      return {
        subject: payload.sub,
        username,
        clientId: typeof payload.azp === "string" ? payload.azp : undefined,
        scopes: typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [],
      };
    } catch (err) {
      throw new InvalidTokenError(err instanceof Error ? err.message : "invalid token");
    }
  };
}

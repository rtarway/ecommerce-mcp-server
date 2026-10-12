import { jwtVerify, type JWTVerifyGetKey } from "jose";

export interface Identity {
  /** Immutable customer id. Everything of value (profile, orders, carts) is keyed by this. */
  subject: string;
  username: string;
  clientId: string | undefined;
  scopes: string[];
  /** Keycloak session id: shared by every access token minted from one refresh-token chain. */
  sessionId?: string;
  tokenId?: string;
  /** Seconds since epoch when the user last authenticated interactively. */
  authTime?: number;
  /** DPoP key thumbprint the token is bound to (RFC 9449), when sender-constrained. */
  jkt?: string;
}

export class InvalidTokenError extends Error {}

export type AuthScheme = "bearer" | "dpop";

export function parseAuthorization(header: string | undefined): { scheme: AuthScheme; token: string } | undefined {
  const match = /^(Bearer|DPoP)\s+(\S+)$/i.exec(header ?? "");
  return match ? { scheme: match[1]!.toLowerCase() as AuthScheme, token: match[2]! } : undefined;
}

export function bearerToken(header: string | undefined): string | undefined {
  const parsed = parseAuthorization(header);
  return parsed?.scheme === "bearer" ? parsed.token : undefined;
}

export interface VerifierConfig {
  issuer: string;
  audience: string;
  keySet: JWTVerifyGetKey;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

export function createTokenVerifier({ issuer, audience, keySet }: VerifierConfig) {
  return async function verify(token: string): Promise<Identity> {
    try {
      const { payload } = await jwtVerify(token, keySet, { issuer, audience, algorithms: ["RS256", "ES256", "PS256"] });
      if (!payload.sub) throw new Error("token has no subject");
      const cnf = payload.cnf as { jkt?: unknown } | undefined;
      return {
        subject: payload.sub,
        username: str(payload.preferred_username) ?? payload.sub,
        clientId: str(payload.azp),
        scopes: typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [],
        sessionId: str(payload.sid),
        tokenId: str(payload.jti),
        authTime: num(payload.auth_time),
        jkt: str(cnf?.jkt),
      };
    } catch (err) {
      throw new InvalidTokenError(err instanceof Error ? err.message : "invalid token");
    }
  };
}

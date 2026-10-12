import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, type JWTVerifyGetKey } from "jose";

export interface LoginResult {
  subject: string;
  /** Seconds since epoch of the interactive authentication. */
  authTime: number | undefined;
}

/** What the approval page needs from an identity provider: send the user to log in, then prove who they are. */
export interface ApprovalLogin {
  begin(redirectUri: string): { url: string; state: string; verifier: string; nonce: string };
  complete(args: { code: string; verifier: string; nonce: string; redirectUri: string }): Promise<LoginResult>;
}

export interface OidcOptions {
  issuer: string;
  /** Browser-facing authorization endpoint (defaults to the Keycloak path under `issuer`). */
  authorizationEndpoint?: string;
  /** Server-side token endpoint (in-cluster address). */
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  keySet: JWTVerifyGetKey;
}

const rand = () => randomBytes(24).toString("base64url");

/** Authorization Code + PKCE with `prompt=login&max_age=0`: the customer must prove themselves again, right now. */
export class OidcLogin implements ApprovalLogin {
  constructor(private readonly o: OidcOptions) {}

  begin(redirectUri: string) {
    const verifier = randomBytes(32).toString("base64url");
    const state = rand();
    const nonce = rand();
    const url = new URL(this.o.authorizationEndpoint ?? `${this.o.issuer}/protocol/openid-connect/auth`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.o.clientId,
      redirect_uri: redirectUri,
      scope: "openid",
      state,
      nonce,
      prompt: "login",
      max_age: "0",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString(), state, verifier, nonce };
  }

  async complete({ code, verifier, nonce, redirectUri }: { code: string; verifier: string; nonce: string; redirectUri: string }): Promise<LoginResult> {
    const res = await fetch(this.o.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.o.clientId)}:${encodeURIComponent(this.o.clientSecret)}`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
    const { id_token } = (await res.json()) as { id_token?: string };
    if (!id_token) throw new Error("no id_token in response");
    const { payload } = await jwtVerify(id_token, this.o.keySet, { issuer: this.o.issuer, audience: this.o.clientId, algorithms: ["RS256", "ES256", "PS256"] });
    if (payload.nonce !== nonce) throw new Error("nonce mismatch");
    if (!payload.sub) throw new Error("id_token has no subject");
    return { subject: payload.sub, authTime: typeof payload.auth_time === "number" ? payload.auth_time : undefined };
  }
}

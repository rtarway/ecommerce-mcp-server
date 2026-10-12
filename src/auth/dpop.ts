import { createHash } from "node:crypto";
import { EmbeddedJWK, calculateJwkThumbprint, jwtVerify, type JWTHeaderParameters, type JWTPayload } from "jose";
import { deleteOldest } from "../shared/collections.js";

export class DpopError extends Error {}

/** Remembers proof ids for the acceptance window so a captured proof cannot be replayed (RFC 9449 §11.1). */
export class ProofReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now, private readonly max = 100_000) {}

  /** True the first time an id is seen inside its window. */
  firstUse(jti: string, ttlMs: number): boolean {
    const t = this.now();
    for (const [id, exp] of this.seen) {
      if (exp > t) break; // insertion order == expiry order for a fixed ttl
      this.seen.delete(id);
    }
    if (this.seen.has(jti)) return false;
    this.seen.set(jti, t + ttlMs);
    if (this.seen.size > this.max) deleteOldest(this.seen);
    return true;
  }
}

export interface DpopCheck {
  proof: string | undefined;
  method: string;
  /** The URL the client used (scheme+host+path, no query/fragment). */
  url: string;
  accessToken: string;
  /** `cnf.jkt` of the access token. */
  expectedJkt: string;
  cache: ProofReplayCache;
  now?: () => number;
}

const WINDOW_SECONDS = 120;

/** Verifies a DPoP proof JWT against the access token it accompanies (RFC 9449 §4.3). */
export async function verifyDpopProof({ proof, method, url, accessToken, expectedJkt, cache, now = Date.now }: DpopCheck): Promise<void> {
  if (!proof) throw new DpopError("missing DPoP proof");
  let payload: JWTPayload;
  let header: JWTHeaderParameters;
  try {
    const verified = await jwtVerify(proof, EmbeddedJWK, { typ: "dpop+jwt", algorithms: ["ES256", "ES384", "ES512", "PS256", "RS256", "EdDSA"], currentDate: new Date(now()) });
    payload = verified.payload;
    header = verified.protectedHeader;
  } catch (err) {
    throw new DpopError(`invalid DPoP proof: ${err instanceof Error ? err.message : "bad signature"}`);
  }
  if (!header.jwk) throw new DpopError("proof has no jwk");
  if ((await calculateJwkThumbprint(header.jwk)) !== expectedJkt) throw new DpopError("proof key does not match the token binding");
  if (payload.htm !== method.toUpperCase()) throw new DpopError("htm mismatch");
  if (payload.htu !== url) throw new DpopError("htu mismatch");
  if (typeof payload.iat !== "number" || Math.abs(now() / 1000 - payload.iat) > WINDOW_SECONDS) throw new DpopError("proof is stale");
  if (payload.ath !== createHash("sha256").update(accessToken).digest("base64url")) throw new DpopError("ath mismatch");
  if (typeof payload.jti !== "string" || !cache.firstUse(payload.jti, WINDOW_SECONDS * 2000)) throw new DpopError("proof replayed");
}

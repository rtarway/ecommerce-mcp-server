import { createHash, randomUUID } from "node:crypto";
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";

/** A client holding its own key pair, producing RFC 9449 proofs. `forge` options let attack tests break one rule at a time. */
export async function createDpopClient() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(jwk);
  return {
    jkt,
    async proof(o: { method: string; url: string; accessToken: string; jti?: string; iat?: number; ath?: string; key?: CryptoKey; jwk?: object }) {
      return new SignJWT({ htm: o.method, htu: o.url, ath: o.ath ?? createHash("sha256").update(o.accessToken).digest("base64url") })
        .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: (o.jwk ?? jwk) as never })
        .setJti(o.jti ?? randomUUID())
        .setIssuedAt(o.iat)
        .sign(o.key ?? privateKey);
    },
  };
}

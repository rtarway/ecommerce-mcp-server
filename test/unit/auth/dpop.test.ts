import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "jose";
import { createDpopClient } from "../../support/dpop.js";
import { DpopError, ProofReplayCache, verifyDpopProof } from "../../../src/auth/dpop.js";

const URL_ = "http://localhost:8000/mcp";
const TOKEN = "access.token.value";

describe("verifyDpopProof (RFC 9449)", () => {
  let client: Awaited<ReturnType<typeof createDpopClient>>;
  let cache: ProofReplayCache;
  beforeEach(async () => {
    client = await createDpopClient();
    cache = new ProofReplayCache();
  });
  const check = (proof: string | undefined, over: object = {}) =>
    verifyDpopProof({ proof, method: "POST", url: URL_, accessToken: TOKEN, expectedJkt: client.jkt, cache, ...over });

  it("accepts a fresh proof from the bound key", async () => {
    await expect(check(await client.proof({ method: "POST", url: URL_, accessToken: TOKEN }))).resolves.toBeUndefined();
  });
  it("rejects a missing proof", async () => {
    await expect(check(undefined)).rejects.toThrow(DpopError);
  });
  it("rejects a proof signed by a different key (a thief cannot mint proofs)", async () => {
    const thief = await createDpopClient();
    await expect(check(await thief.proof({ method: "POST", url: URL_, accessToken: TOKEN }))).rejects.toThrow(/binding/);
  });
  it("rejects a proof whose embedded key is not the one that signed it", async () => {
    const thief = await generateKeyPair("ES256");
    const proof = await client.proof({ method: "POST", url: URL_, accessToken: TOKEN, key: thief.privateKey });
    await expect(check(proof)).rejects.toThrow(DpopError);
  });
  it("rejects a proof for another method, URL or access token", async () => {
    await expect(check(await client.proof({ method: "GET", url: URL_, accessToken: TOKEN }))).rejects.toThrow(/htm/);
    await expect(check(await client.proof({ method: "POST", url: "http://evil/mcp", accessToken: TOKEN }))).rejects.toThrow(/htu/);
    await expect(check(await client.proof({ method: "POST", url: URL_, accessToken: "other.token" }))).rejects.toThrow(/ath/);
  });
  it("rejects stale proofs", async () => {
    const old = Math.floor(Date.now() / 1000) - 600;
    await expect(check(await client.proof({ method: "POST", url: URL_, accessToken: TOKEN, iat: old }))).rejects.toThrow(/stale|exp|iat/);
  });
  it("rejects a replayed proof", async () => {
    const proof = await client.proof({ method: "POST", url: URL_, accessToken: TOKEN });
    await check(proof);
    await expect(check(proof)).rejects.toThrow(/replayed/);
  });
});

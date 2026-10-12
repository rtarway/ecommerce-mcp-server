import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "jose";
import { AUDIENCE, ISSUER, createTestIdp, type TestIdp } from "../../support/tokens.js";
import { InvalidTokenError, bearerToken, createTokenVerifier, parseAuthorization } from "../../../src/auth/tokens.js";

describe("bearerToken", () => {
  it("extracts the token from an Authorization header", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("bearer abc.def")).toBe("abc.def");
  });
  it("returns undefined when absent or not a bearer credential", () => {
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken("Bearer ")).toBeUndefined();
  });
});

describe("parseAuthorization", () => {
  it("tells Bearer from DPoP so bound tokens cannot be downgraded", () => {
    expect(parseAuthorization("DPoP abc")).toEqual({ scheme: "dpop", token: "abc" });
    expect(parseAuthorization("Bearer abc")).toEqual({ scheme: "bearer", token: "abc" });
    expect(bearerToken("DPoP abc")).toBeUndefined();
  });
});

describe("createTokenVerifier", () => {
  let idp: TestIdp;
  let verify: ReturnType<typeof createTokenVerifier>;
  beforeAll(async () => {
    idp = await createTestIdp();
    verify = createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: idp.keySet });
  });

  it("returns the identity carried by a valid token", async () => {
    const token = await idp.sign({ scope: "openid ecommerce:checkout" });
    expect(await verify(token)).toEqual({
      subject: "user-123",
      username: "testuser",
      clientId: "mcp-test-client",
      scopes: ["openid", "ecommerce:checkout"],
    });
  });

  it("carries session, freshness and sender-binding claims", async () => {
    const token = await idp.sign({ sid: "kc-sid", jti: "tok-1", auth_time: 1700000000, cnf: { jkt: "thumb" } });
    expect(await verify(token)).toMatchObject({ sessionId: "kc-sid", tokenId: "tok-1", authTime: 1700000000, jkt: "thumb" });
  });

  it("rejects expired tokens", async () => {
    const token = await idp.sign({}, { expiresIn: "-1m" });
    await expect(verify(token)).rejects.toThrow(InvalidTokenError);
  });

  it("rejects the wrong issuer or audience", async () => {
    await expect(verify(await idp.sign({}, { issuer: "http://evil/realms/mcp" }))).rejects.toThrow(InvalidTokenError);
    await expect(verify(await idp.sign({}, { audience: "http://other/mcp" }))).rejects.toThrow(InvalidTokenError);
  });

  it("rejects tokens signed by an unknown key", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    await expect(verify(await idp.sign({}, { key: privateKey }))).rejects.toThrow(InvalidTokenError);
  });

  it("rejects garbage", async () => {
    await expect(verify("not-a-jwt")).rejects.toThrow(InvalidTokenError);
  });

  it("rejects tokens with no subject", async () => {
    const token = await idp.sign({ sub: undefined });
    await expect(verify(token)).rejects.toThrow(InvalidTokenError);
  });
});

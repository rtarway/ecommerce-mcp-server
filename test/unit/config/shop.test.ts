import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config/shop.js";

const env = {
  ISSUER: "http://localhost:8080/realms/mcp",
  JWKS_URL: "http://keycloak-service.keycloak:8080/realms/mcp/protocol/openid-connect/certs",
  RESOURCE_URL: "http://localhost:8000/mcp",
  PUBLIC_BASE_URL: "http://localhost:8000",
};

describe("loadConfig", () => {
  it("parses env, defaulting the port and deriving the resource-metadata URL (RFC 9728)", () => {
    const config = loadConfig(env);
    expect(config.PORT).toBe(3000);
    expect(config.resourceMetadataUrl).toBe("http://localhost:8000/.well-known/oauth-protected-resource/mcp");
  });

  it("secure by default: approvals, no trusted gateway headers, bounded state", () => {
    const config = loadConfig(env);
    expect(config.REQUIRE_APPROVAL).toBe(true);
    expect(config.TRUST_GATEWAY_HEADERS).toBe(false);
    expect(config.REQUIRE_DPOP).toBe(false);
    expect(config.MAX_SESSIONS).toBeGreaterThan(0);
    expect(config.DEMO_PROFILE_SUBJECTS).toEqual([]);
  });

  it("refuses to start with approvals required but no way to serve the approval page", () => {
    const { PUBLIC_BASE_URL: _unused, ...noBase } = env;
    expect(() => loadConfig(noBase)).toThrow(/PUBLIC_BASE_URL/);
    expect(loadConfig({ ...noBase, REQUIRE_APPROVAL: "false" }).REQUIRE_APPROVAL).toBe(false);
  });

  it("parses the demo customer list", () => {
    expect(loadConfig({ ...env, DEMO_PROFILE_SUBJECTS: "a, b ,," }).DEMO_PROFILE_SUBJECTS).toEqual(["a", "b"]);
  });

  it("fails fast on missing or malformed settings", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ ...env, ISSUER: "nope" })).toThrow();
  });
});

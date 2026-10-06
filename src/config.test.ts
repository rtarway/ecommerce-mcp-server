import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const env = {
  ISSUER: "http://localhost:8080/realms/mcp",
  JWKS_URL: "http://keycloak-service.keycloak:8080/realms/mcp/protocol/openid-connect/certs",
  RESOURCE_URL: "http://localhost:8000/mcp",
};

describe("loadConfig", () => {
  it("parses env, defaulting the port and deriving the resource-metadata URL (RFC 9728)", () => {
    const config = loadConfig(env);
    expect(config.PORT).toBe(3000);
    expect(config.resourceMetadataUrl).toBe("http://localhost:8000/.well-known/oauth-protected-resource/mcp");
  });

  it("fails fast on missing or malformed settings", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ ...env, ISSUER: "nope" })).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { loadSessionManagerConfig } from "../../../src/config/session-manager.js";

const env = {
  ISSUER: "http://localhost:8080/realms/mcp",
  JWKS_URL: "http://keycloak:8080/realms/mcp/protocol/openid-connect/certs",
  RESOURCE_URL: "http://localhost:8000/mcp",
  KEYCLOAK_URL: "http://keycloak:8080",
  SM_CLIENT_SECRET: "s".repeat(16),
  ADMIN_TOKEN: "a".repeat(24),
};

describe("loadSessionManagerConfig", () => {
  it("applies defaults and derives the resource-metadata URL", () => {
    const c = loadSessionManagerConfig(env);
    expect(c).toMatchObject({ PORT: 3100, KEYCLOAK_REALM: "mcp", COOLING_OFF_SECONDS: 0, INCIDENT_WINDOW_SECONDS: 900, EVENT_POLL_SECONDS: 10 });
    expect(c.resourceMetadataUrl).toBe("http://localhost:8000/.well-known/oauth-protected-resource/mcp");
  });

  it("refuses weak secrets", () => {
    expect(() => loadSessionManagerConfig({ ...env, ADMIN_TOKEN: "short" })).toThrow();
    expect(() => loadSessionManagerConfig({ ...env, SM_CLIENT_SECRET: "short" })).toThrow();
  });
});

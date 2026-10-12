import { describe, expect, it } from "vitest";
import { isRefreshTokenReuse } from "../../../src/session-manager/keycloak.js";

describe("isRefreshTokenReuse", () => {
  it("recognises Keycloak's rotation-violation event but not an ordinary expiry", () => {
    const base = { time: 1, userId: "u", clientId: "c" };
    expect(isRefreshTokenReuse({ ...base, type: "REFRESH_TOKEN_ERROR", error: "invalid_token", details: { reason: "Maximum allowed refresh token reuse exceeded" } })).toBe(true);
    expect(isRefreshTokenReuse({ ...base, type: "REFRESH_TOKEN_ERROR", error: "invalid_token", details: { reason: "Token is not active" } })).toBe(false);
    expect(isRefreshTokenReuse({ ...base, type: "LOGIN_ERROR", error: "reuse" })).toBe(false);
    expect(isRefreshTokenReuse({ time: 1, type: "REFRESH_TOKEN_ERROR", error: "reuse" })).toBe(false); // names neither user nor session
    // what Keycloak 26.8 really sends: a session id and no user id
    expect(isRefreshTokenReuse({ time: 1, type: "REFRESH_TOKEN_ERROR", sessionId: "s", clientId: "c", error: "invalid_token", details: { reason: "Maximum allowed refresh token reuse exceeded" } })).toBe(true);
  });
});

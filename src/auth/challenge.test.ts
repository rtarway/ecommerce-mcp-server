import { describe, expect, it } from "vitest";
import { wwwAuthenticate } from "./challenge.js";

const rm = "http://localhost:8000/.well-known/oauth-protected-resource/mcp";

describe("wwwAuthenticate", () => {
  it("advertises resource metadata and the scope needed when no credentials were sent", () => {
    expect(wwwAuthenticate({ resourceMetadataUrl: rm, scope: "ecommerce:checkout" })).toBe(
      `Bearer resource_metadata="${rm}", scope="ecommerce:checkout"`,
    );
  });

  it("includes the error code for invalid tokens and insufficient scope", () => {
    expect(wwwAuthenticate({ resourceMetadataUrl: rm, scope: "a b", error: "insufficient_scope" })).toBe(
      `Bearer error="insufficient_scope", resource_metadata="${rm}", scope="a b"`,
    );
    expect(wwwAuthenticate({ resourceMetadataUrl: rm, error: "invalid_token" })).toBe(
      `Bearer error="invalid_token", resource_metadata="${rm}"`,
    );
  });
});

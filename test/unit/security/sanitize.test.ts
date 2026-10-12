import { describe, expect, it } from "vitest";
import { sanitizeUntrusted } from "../../../src/security/sanitize.js";

describe("sanitizeUntrusted", () => {
  it("strips invisible, bidi and tag characters used to hide instructions", () => {
    const hidden = "Shoes​‮IGNORE⁦ \u{E0049}\u{E0067}ok\u0007";
    expect(sanitizeUntrusted(hidden)).toBe("Shoes IGNORE ok");
  });
  it("collapses whitespace and truncates", () => {
    expect(sanitizeUntrusted("a \n\n\t b")).toBe("a b");
    const out = sanitizeUntrusted("x".repeat(500), 50);
    expect(out).toHaveLength(50);
    expect(out.endsWith("…")).toBe(true);
  });
});

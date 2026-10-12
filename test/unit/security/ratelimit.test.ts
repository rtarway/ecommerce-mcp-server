import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../../src/security/ratelimit.js";

describe("RateLimiter", () => {
  it("allows up to the limit per window per key, then resets", () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    expect([1, 2, 3, 4].map(() => rl.allow("a", 3))).toEqual([true, true, true, false]);
    expect(rl.allow("b", 3)).toBe(true);
    t = 60_001;
    expect(rl.allow("a", 3)).toBe(true);
  });
  it("bounds its own memory", () => {
    const rl = new RateLimiter(() => 0, 10);
    for (let i = 0; i < 1000; i++) rl.allow(`k${i}`, 1);
    expect(rl.allow("k0", 1)).toBe(true); // forgotten, so counted afresh
  });
});

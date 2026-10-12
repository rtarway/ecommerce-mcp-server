import { describe, expect, it } from "vitest";
import { SessionCapacityError, SessionRegistry } from "../../../src/session/registry.js";

describe("SessionRegistry", () => {
  const make = (t: { v: number }, over = {}) => {
    let n = 0;
    return new SessionRegistry({ idleMs: 1000, maxAgeMs: 5000, maxSessions: 3, maxPerSource: 2, now: () => t.v, newId: () => `s${++n}`, ...over });
  };

  it("validates only ids it issued", () => {
    const r = make({ v: 0 });
    const id = r.issue("1.1.1.1");
    expect(r.validate(id)).toBe(true);
    expect(r.validate("victim-session-guess")).toBe(false);
  });
  it("expires idle sessions but keeps active ones until the hard maximum", () => {
    const t = { v: 0 };
    const r = make(t);
    const id = r.issue("a");
    t.v = 900;
    expect(r.validate(id)).toBe(true);
    for (t.v = 1800; t.v <= 4800; t.v += 900) expect(r.validate(id)).toBe(true);
    t.v = 5200;
    expect(r.validate(id)).toBe(false);
  });
  it("binds a session to the first customer that uses it", () => {
    const r = make({ v: 0 });
    const id = r.issue("a");
    expect(r.check(id)).toBe("ok"); // anonymous use of an unbound session
    expect(r.check(id, "alice")).toBe("ok"); // binds
    expect(r.check(id, "alice")).toBe("ok");
    expect(r.check(id, "mallory")).toBe("foreign");
    expect(r.check(id)).toBe("foreign"); // a signed-in session cannot be used anonymously
    expect(r.check("nope", "alice")).toBe("unknown");
    expect(r.check(r.issue("a", "bob"), "alice")).toBe("foreign"); // bound at issue
  });

  it("caps sessions per source and in total", () => {
    const r = make({ v: 0 });
    r.issue("a");
    r.issue("a");
    expect(() => r.issue("a")).toThrow(SessionCapacityError);
    r.issue("b");
    expect(() => r.issue("c")).toThrow(SessionCapacityError);
  });
  it("frees capacity on termination and expiry", () => {
    const t = { v: 0 };
    const r = make(t);
    const id = r.issue("a");
    r.issue("a");
    r.terminate(id);
    expect(r.validate(id)).toBe(false);
    r.issue("a");
    t.v = 6000;
    r.sweep();
    expect(r.size).toBe(0);
  });
});

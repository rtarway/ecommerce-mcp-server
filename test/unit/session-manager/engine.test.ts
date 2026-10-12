import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAudit } from "../../../src/security/audit.js";
import { SessionManager, networkOf } from "../../../src/session-manager/engine.js";
import { ELSEWHERE, FakeAdmin, HOME, Notes, id } from "../../support/session-manager.js";

describe("networkOf", () => {
  it("groups IPv4 by /24 and IPv6 by /48 so roaming inside a range is not theft", () => {
    expect(networkOf("203.0.113.7")).toBe(networkOf("203.0.113.200"));
    expect(networkOf("203.0.113.7")).not.toBe(networkOf("198.51.100.9"));
    expect(networkOf("::ffff:203.0.113.7")).toBe("203.0.113.0/24");
    expect(networkOf("2001:db8:1:aaaa::1")).toBe(networkOf("2001:db8:1:bbbb::2"));
  });
});

describe("SessionManager", () => {
  let t: number;
  let admin: FakeAdmin;
  let notes: Notes;
  let audit: MemoryAudit;
  let sm: SessionManager;
  const make = (over = {}) => new SessionManager({ admin, notifier: notes, audit, now: () => t, ...over });
  beforeEach(() => {
    t = 1_000_000;
    admin = new FakeAdmin();
    notes = new Notes();
    audit = new MemoryAudit();
    sm = make();
  });

  it("lets anonymous browsing through untracked", () => {
    expect(sm.evaluate({ source: HOME })).toEqual({ action: "allow", tier: "anonymous" });
  });

  it("allows a customer's several legitimate installations (a second client is normal, not an incident)", () => {
    expect(sm.evaluate({ identity: id(), source: HOME })).toMatchObject({ action: "allow", tier: "normal" });
    expect(sm.evaluate({ identity: id({ clientId: "agent-b", sessionId: "sid-2" }), source: HOME })).toMatchObject({ action: "allow", tier: "normal" });
    expect(notes.sent).toEqual(["cust-1:new_installation"]); // second one is notified, first is not
    expect(admin.calls).toEqual([]);
  });

  it("holds a new installation of an existing customer back from checkout while cooling off, then releases it", () => {
    sm = make({ coolingOffMs: 60_000 });
    sm.evaluate({ identity: id(), source: HOME });
    const second = id({ clientId: "agent-b", sessionId: "sid-2" });
    expect(sm.evaluate({ identity: second, source: HOME })).toMatchObject({ tier: "cooling_off" });
    t += 61_000;
    expect(sm.evaluate({ identity: second, source: HOME })).toMatchObject({ tier: "normal" });
  });

  it("does not cool off a customer's very first link", () => {
    sm = make({ coolingOffMs: 60_000 });
    expect(sm.evaluate({ identity: id(), source: HOME })).toMatchObject({ tier: "normal" });
  });

  it("THEFT: the same token family from two unrelated networks inside the window ends all of the customer's sessions", async () => {
    sm.evaluate({ identity: id(), source: HOME });
    sm.evaluate({ identity: id({ clientId: "agent-b", sessionId: "sid-2" }), source: HOME });
    t += 30_000;
    const thief = sm.evaluate({ identity: id(), source: ELSEWHERE });
    expect(thief).toMatchObject({ action: "deny", status: 401, error: "invalid_token" });
    await sm.idle();
    expect(admin.calls).toEqual(expect.arrayContaining(["logout:cust-1", "revoke:cust-1:agent-a", "revoke:cust-1:agent-b"]));
    expect(notes.sent).toContain("cust-1:sessions_terminated");
    // the customer's *other* installation is cut too (accepted cost) ...
    expect(sm.evaluate({ identity: id({ clientId: "agent-b", sessionId: "sid-2" }), source: HOME })).toMatchObject({ action: "deny" });
    // ... and so is every later copy of the stolen token, from anywhere
    expect(sm.evaluate({ identity: id(), source: HOME })).toMatchObject({ action: "deny" });
  });

  it("a fresh login after the reset gets back in but is cooling-off for checkout during the incident window", async () => {
    sm.evaluate({ identity: id(), source: HOME });
    await sm.terminateCustomer("cust-1", "operator_request");
    const relogin = id({ sessionId: "sid-NEW", tokenId: "jti-new" });
    expect(sm.evaluate({ identity: relogin, source: HOME })).toMatchObject({ action: "allow", tier: "cooling_off" });
    t += 16 * 60_000;
    expect(sm.evaluate({ identity: relogin, source: HOME })).toMatchObject({ action: "allow", tier: "normal" });
  });

  it("does not mistake normal roaming for theft once the window has passed, or within one network", () => {
    sm.evaluate({ identity: id(), source: HOME });
    expect(sm.evaluate({ identity: id(), source: "203.0.113.99" })).toMatchObject({ action: "allow" });
    t += 5 * 60_000;
    expect(sm.evaluate({ identity: id(), source: ELSEWHERE })).toMatchObject({ action: "allow" });
  });

  it("cannot be turned into a lockout machine: remote invalidation is rate limited, local denial is not", async () => {
    for (let i = 0; i < 6; i++) await sm.terminateCustomer("cust-1", "operator_request");
    expect(admin.calls.filter((c) => c.startsWith("logout"))).toHaveLength(3);
  });

  it("keeps denying locally even when Keycloak is unreachable", async () => {
    admin.fail = true;
    sm.evaluate({ identity: id(), source: HOME });
    await sm.terminateCustomer("cust-1", "refresh_token_reuse");
    expect(sm.evaluate({ identity: id(), source: HOME })).toMatchObject({ action: "deny" });
  });

  it("slows a customer who suddenly links many new apps", () => {
    sm = make({ maxNewInstallationsPerHour: 3 });
    const r = [1, 2, 3, 4].map((n) => sm.evaluate({ identity: id({ clientId: `a${n}`, sessionId: `s${n}` }), source: HOME }));
    expect(r.map((d) => d.action === "allow")).toEqual([true, true, true, false]);
    expect(r[3]).toMatchObject({ status: 429 });
  });

  it("tokens without a sid are still tracked, by their jti", () => {
    const noSid = id({ sessionId: undefined });
    sm.evaluate({ identity: noSid, source: HOME });
    expect(sm.evaluate({ identity: noSid, source: ELSEWHERE })).toMatchObject({ action: "deny" });
  });

  it("exposes a token-free snapshot for operators", () => {
    sm.evaluate({ identity: id(), source: HOME });
    const snap = sm.snapshot("cust-1")!;
    expect(snap.installations[0]).toMatchObject({ azp: "agent-a", networks: ["203.0.113.0/24"], terminated: false });
    expect(JSON.stringify(snap)).not.toMatch(/jti-1|Bearer/);
  });
});

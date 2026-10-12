import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AUDIENCE, ISSUER, createTestIdp, type TestIdp } from "../../test/support/tokens.js";
import { createTokenVerifier, type Identity } from "../auth/tokens.js";
import { MemoryAudit } from "../security/audit.js";
import { createSessionManagerApp } from "./app.js";
import { SessionManager, networkOf, type KeycloakAdmin, type Notifier } from "./engine.js";
import { isRefreshTokenReuse } from "./keycloak.js";

const id = (over: Partial<Identity> = {}): Identity => ({ subject: "cust-1", username: "u", clientId: "agent-a", scopes: [], sessionId: "sid-1", tokenId: "jti-1", ...over });
const HOME = "203.0.113.7";
const ELSEWHERE = "198.51.100.9";

class FakeAdmin implements KeycloakAdmin {
  calls: string[] = [];
  fail = false;
  async logoutUser(sub: string) {
    if (this.fail) throw new Error("keycloak down");
    this.calls.push(`logout:${sub}`);
  }
  async revokeConsent(sub: string, clientId: string) {
    this.calls.push(`revoke:${sub}:${clientId}`);
  }
}
class Notes implements Notifier {
  sent: string[] = [];
  notify(sub: string, kind: string) {
    this.sent.push(`${sub}:${kind}`);
  }
}

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

describe("session-manager HTTP (gateway extAuth + events)", () => {
  let idp: TestIdp;
  let server: Server;
  let base: string;
  let admin: FakeAdmin;
  let sm: SessionManager;
  beforeAll(async () => {
    idp = await createTestIdp();
  });
  beforeEach(async () => {
    admin = new FakeAdmin();
    sm = new SessionManager({ admin, notifier: new Notes(), audit: new MemoryAudit() });
    server?.close();
    server = createSessionManagerApp({
      engine: sm,
      verify: createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: idp.keySet }),
      adminToken: "admin-secret-admin-secret-1234",
      resourceMetadataUrl: "http://localhost:8000/.well-known/oauth-protected-resource/mcp",
    }).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  const check = async (token: string | undefined, xff = HOME) =>
    fetch(`${base}/check/mcp`, { method: "POST", headers: { "x-forwarded-for": xff, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const admin_ = { authorization: "Bearer admin-secret-admin-secret-1234", "content-type": "application/json" };

  it("allows anonymous and tags valid customers with a trust tier", async () => {
    expect((await check(undefined)).headers.get("x-trust-tier")).toBe("anonymous");
    const ok = await check(await idp.sign({ sid: "s1", azp: "agent-a" }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-trust-tier")).toBe("normal");
    expect(ok.headers.get("x-installation-id")).toBe("agent-a|s1");
  });

  it("does not trust claims it cannot verify: a forged token is treated as anonymous, never as a customer", async () => {
    const res = await check("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-trust-tier")).toBe("anonymous");
    expect(sm.snapshot("x")).toBeUndefined();
  });

  it("denies a stolen token replayed from another network, with a challenge that makes the client re-authenticate", async () => {
    const token = await idp.sign({ sid: "s1" });
    expect((await check(token, HOME)).status).toBe(200);
    const res = await check(token, ELSEWHERE);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect((await check(token, HOME)).status).toBe(401);
  });

  it("uses the last X-Forwarded-For hop (the one the gateway added), not what the client claimed", async () => {
    const token = await idp.sign({ sid: "s1" });
    await check(token, `1.1.1.1, ${HOME}`);
    expect((await check(token, `2.2.2.2, ${HOME}`)).status).toBe(200); // same real network, spoofed first hop ignored
  });

  it("operator and event endpoints require the admin token", async () => {
    expect((await fetch(`${base}/v1/customers/cust-1/terminate`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/v1/events/keycloak`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" })).status).toBe(401);
    expect((await fetch(`${base}/check`, { method: "POST" })).status).toBe(200); // the gateway path is open
  });

  it("ingests a Keycloak refresh-token-reuse event and runs the playbook; ignores benign events", async () => {
    const token = await idp.sign({ sid: "s1", sub: "cust-9" });
    await check(token);
    const benign = await fetch(`${base}/v1/events/keycloak`, { method: "POST", headers: admin_, body: JSON.stringify({ time: 1, type: "REFRESH_TOKEN_ERROR", userId: "cust-9", error: "invalid_token", details: { reason: "Token is not active" } }) });
    expect(await benign.json()).toMatchObject({ acted: 0 });
    expect((await check(token)).status).toBe(200);
    const reuse = await fetch(`${base}/v1/events/keycloak`, { method: "POST", headers: admin_, body: JSON.stringify([{ time: 2, type: "REFRESH_TOKEN_ERROR", userId: "cust-9", clientId: "mcp-test-client", details: { reason: "Maximum allowed refresh token reuse exceeded" } }]) });
    expect(await reuse.json()).toMatchObject({ acted: 1 });
    expect((await check(token)).status).toBe(401);
    expect(admin.calls).toContain("logout:cust-9");
  });

  it("resolves the customer from the Keycloak session id when the event has no user id (real Keycloak behaviour)", async () => {
    const token = await idp.sign({ sid: "kc-sess-7", sub: "cust-7" });
    await check(token);
    const ev = { time: 3, type: "REFRESH_TOKEN_ERROR", sessionId: "kc-sess-7", clientId: "mcp-test-client", error: "invalid_token", details: { reason: "Maximum allowed refresh token reuse exceeded" } };
    const unknown = await fetch(`${base}/v1/events/keycloak`, { method: "POST", headers: admin_, body: JSON.stringify({ ...ev, sessionId: "never-seen" }) });
    expect(await unknown.json()).toMatchObject({ acted: 0 });
    const res = await fetch(`${base}/v1/events/keycloak`, { method: "POST", headers: admin_, body: JSON.stringify(ev) });
    expect(await res.json()).toMatchObject({ acted: 1 });
    expect((await check(token)).status).toBe(401);
    expect(admin.calls).toContain("logout:cust-7");
  });

  it("lets an operator terminate and inspect a customer", async () => {
    await check(await idp.sign({ sid: "s1", sub: "cust-5" }));
    const snap = await (await fetch(`${base}/v1/customers/cust-5`, { headers: admin_ })).json();
    expect(snap.installations).toHaveLength(1);
    expect((await fetch(`${base}/v1/customers/cust-5/terminate`, { method: "POST", headers: admin_ })).status).toBe(202);
    expect((await check(await idp.sign({ sid: "s1", sub: "cust-5" }))).status).toBe(401);
    expect((await fetch(`${base}/v1/customers/nobody`, { headers: admin_ })).status).toBe(404);
  });
});

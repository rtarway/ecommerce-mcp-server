import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AUDIENCE, ISSUER, createTestIdp, type TestIdp } from "../../support/tokens.js";
import { createTokenVerifier } from "../../../src/auth/tokens.js";
import { MemoryAudit } from "../../../src/security/audit.js";
import { createSessionManagerApp } from "../../../src/session-manager/app.js";
import { SessionManager } from "../../../src/session-manager/engine.js";
import { ELSEWHERE, FakeAdmin, HOME, Notes } from "../../support/session-manager.js";

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

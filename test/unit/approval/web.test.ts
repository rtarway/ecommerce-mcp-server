import { beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MemoryAudit } from "../../../src/security/audit.js";
import type { ApprovalLogin } from "../../../src/approval/oidc.js";
import { ApprovalService } from "../../../src/approval/service.js";
import { ApprovalWeb } from "../../../src/approval/web.js";
import { summary } from "../../support/approval.js";

/** Identity provider stand-in: the "browser" is the test, the IdP is a function. */
class FakeLogin implements ApprovalLogin {
  next: { subject: string; authTime: number | undefined } = { subject: "u1", authTime: Math.floor(Date.now() / 1000) };
  begin(redirectUri: string) {
    return { url: `http://idp.test/auth?redirect_uri=${encodeURIComponent(redirectUri)}&state=S1`, state: "S1", verifier: "v", nonce: "n" };
  }
  async complete(a: { code: string }) {
    if (a.code === "bad") throw new Error("nope");
    return this.next;
  }
}

describe("ApprovalWeb", () => {
  let approvals: ApprovalService;
  let login: FakeLogin;
  let audit: MemoryAudit;
  let server: Server;
  let base: string;
  beforeEach(async () => {
    approvals = new ApprovalService({ ttlMs: 60_000 });
    login = new FakeLogin();
    audit = new MemoryAudit();
    const web = new ApprovalWeb({ approvals, login, audit, publicBaseUrl: "http://shop.test" });
    server = createServer((req: IncomingMessage, res: ServerResponse) => void web.handle(req, res, new URL(req.url!, "http://x")));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return () => void server.close();
  });

  const get = (path: string, cookie = "") => fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith(`${name}=`))!;

  /** Runs link → IdP → callback; returns the callback response. */
  async function signIn(id: string, code = "good") {
    const start = await get(`/approve/${id}`);
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toContain("http://idp.test/auth");
    return get(`/approve/callback?code=${code}&state=S1`, cookieOf(start, "ap_state"));
  }
  const decide = (cookie: string, csrf: string, decision: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/approve/decision`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie, ...headers },
      body: new URLSearchParams({ csrf, decision }),
    });
  const csrfOf = async (res: Response) => /name="csrf" value="([^"]+)"/.exec(await res.text())![1]!;

  it("shows the true basket, escaped, only after a fresh sign-in as the right customer, then records approval", async () => {
    const a = approvals.request("u1", "c", "h", summary);
    const cb = await signIn(a.id);
    expect(cb.status).toBe(200);
    const html = await cb.clone().text();
    expect(html).toContain("$20.00");
    expect(html).toContain("ending 4242");
    expect(html).toContain("Shoes &lt;b&gt;");
    expect(cb.headers.get("x-frame-options")).toBe("DENY");
    // no-referrer would make real browsers send `Origin: null` on the Approve click, which the origin check refuses
    expect(cb.headers.get("referrer-policy")).toBe("same-origin");
    expect(cb.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const res = await decide(cookieOf(cb, "ap_session"), await csrfOf(cb), "approve");
    expect(res.status).toBe(200);
    expect(a.status).toBe("approved");
    expect(audit.events()).toContain("approval_granted");
  });

  it("with an order placer, Approve places the order and shows its id; a failed placement charges nothing", async () => {
    const placed: string[] = [];
    let fail = false;
    const web2 = new ApprovalWeb({
      approvals, login, audit, publicBaseUrl: "http://shop.test",
      placeOrder: (a) => {
        if (fail) throw new Error("Daily spending limit for agent purchases reached");
        placed.push(a.id);
        approvals.consume(a.id, "ord_123");
        return { orderId: "ord_123", totalCents: a.summary.totalCents };
      },
    });
    const srv = createServer((req: IncomingMessage, res: ServerResponse) => void web2.handle(req, res, new URL(req.url!, "http://x")));
    await new Promise<void>((r) => srv.listen(0, r));
    const base2 = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const flow = async (approvalId: string) => {
      const start = await fetch(`${base2}/approve/${approvalId}`, { redirect: "manual" });
      const cb = await fetch(`${base2}/approve/callback?code=good&state=S1`, { redirect: "manual", headers: { cookie: cookieOf(start, "ap_state") } });
      return fetch(`${base2}/approve/decision`, {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieOf(cb, "ap_session") },
        body: new URLSearchParams({ csrf: await csrfOf(cb), decision: "approve" }),
      });
    };
    const a = approvals.request("u1", "c", "h", summary);
    const ok = await flow(a.id);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toMatch(/Order ord_123 for \$20\.00 is placed/);
    expect(placed).toEqual([a.id]);
    expect(audit.events()).toContain("order_placed");

    fail = true;
    const b = approvals.request("u1", "c", "h2", summary);
    const no = await flow(b.id);
    expect(no.status).toBe(409);
    expect(await no.text()).toMatch(/Nothing was charged: Daily spending limit/);
    srv.close();
  });

  it("lets the customer cancel", async () => {
    const a = approvals.request("u1", "c", "h", summary);
    const cb = await signIn(a.id);
    await decide(cookieOf(cb, "ap_session"), await csrfOf(cb), "deny");
    expect(a.status).toBe("denied");
  });

  it("refuses someone else's login (phished link) and audits it", async () => {
    login.next = { subject: "attacker", authTime: Math.floor(Date.now() / 1000) };
    const a = approvals.request("u1", "c", "h", summary);
    const cb = await signIn(a.id);
    expect(cb.status).toBe(403);
    expect(a.status).toBe("pending");
    expect(audit.events()).toContain("approval_wrong_user");
  });

  it("refuses a lingering SSO session: the login must be fresh", async () => {
    login.next = { subject: "u1", authTime: Math.floor(Date.now() / 1000) - 3600 };
    const a = approvals.request("u1", "c", "h", summary);
    expect((await signIn(a.id)).status).toBe(400);
    login.next = { subject: "u1", authTime: undefined };
    expect((await signIn(a.id)).status).toBe(400);
    expect(a.status).toBe("pending");
  });

  it("rejects a callback without the browser's state cookie (login CSRF) and replayed states", async () => {
    const a = approvals.request("u1", "c", "h", summary);
    await get(`/approve/${a.id}`);
    expect((await get(`/approve/callback?code=good&state=S1`)).status).toBe(400); // no cookie
    const start = await get(`/approve/${a.id}`);
    const ok = await get(`/approve/callback?code=good&state=S1`, cookieOf(start, "ap_state"));
    expect(ok.status).toBe(200);
    expect((await get(`/approve/callback?code=good&state=S1`, cookieOf(start, "ap_state"))).status).toBe(400); // state is single-use
  });

  it("rejects a failed code exchange", async () => {
    const a = approvals.request("u1", "c", "h", summary);
    expect((await signIn(a.id, "bad")).status).toBe(400);
  });

  it("needs the CSRF token and the session cookie, and ignores cross-origin posts", async () => {
    const a = approvals.request("u1", "c", "h", summary);
    const cb = await signIn(a.id);
    const cookie = cookieOf(cb, "ap_session");
    expect((await decide(cookie, "wrong", "approve")).status).toBe(403);
    expect(a.status).toBe("pending");

    const cb2 = await signIn(a.id);
    expect((await decide(cookieOf(cb2, "ap_session"), await csrfOf(cb2), "approve", { origin: "http://evil.example" })).status).toBe(403);
    const cb3 = await signIn(a.id);
    expect((await decide(cookieOf(cb3, "ap_session"), await csrfOf(cb3), "approve", { origin: "null" })).status).toBe(403); // opaque origin
    expect((await decide("", "x", "approve")).status).toBe(403);
    expect(a.status).toBe("pending");
    const cb4 = await signIn(a.id);
    expect((await decide(cookieOf(cb4, "ap_session"), await csrfOf(cb4), "approve", { origin: "http://shop.test" })).status).toBe(200); // what a browser sends
    expect(a.status).toBe("approved");
  });

  it("a decision session is single-use", async () => {
    const a = approvals.request("u1", "c", "h", summary);
    const cb = await signIn(a.id);
    const cookie = cookieOf(cb, "ap_session");
    const csrf = await csrfOf(cb);
    await decide(cookie, csrf, "deny");
    expect((await decide(cookie, csrf, "approve")).status).toBe(403);
    expect(a.status).toBe("denied");
  });

  it("unknown, expired and malformed links reveal nothing", async () => {
    expect((await get("/approve/not-an-id")).status).toBe(404);
    expect((await get(`/approve/${"a".repeat(43)}`)).status).toBe(410);
  });
});

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuditLog } from "../security/audit.js";
import { messagePage, reviewPage } from "./page.js";
import { deleteOldest } from "../shared/collections.js";
import type { ApprovalLogin, LoginResult } from "./oidc.js";
import type { Approval, ApprovalService } from "./service.js";

interface LoginContext {
  approvalId: string;
  verifier: string;
  nonce: string;
  startedAt: number;
  expires: number;
}

interface WebSession {
  approvalId: string;
  subject: string;
  csrf: string;
  expires: number;
}

export interface ApprovalWebOptions {
  approvals: ApprovalService;
  login: ApprovalLogin;
  audit: AuditLog;
  /** Browser-visible origin + path prefix of this service (the gateway), no trailing slash. */
  publicBaseUrl: string;
  now?: () => number;
  /**
   * Places the order when the customer clicks "Approve and pay", so the button does what it says and the customer
   * sees the order id. Without it (tests), approval only marks the request and the agent's next checkout call buys.
   */
  placeOrder?: (approval: Approval) => { orderId: string; totalCents: number };
}

const LOGIN_TTL_MS = 10 * 60_000;
const MAX_PENDING_LOGINS = 10_000;
/** Allowed clock difference between us and the identity provider when checking how fresh the login is. */
const AUTH_SKEW_SECONDS = 10;

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  // same-origin, not no-referrer: under no-referrer browsers send `Origin: null` on form POSTs, which the origin check
  // below must (and does) refuse, so the customer's own Approve click was blocked. Nothing leaks to other sites.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY", // a clickjacked "Approve" button is the whole attack
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** HTTP surface for human approval: login with the identity provider, review, approve or cancel. */
export class ApprovalWeb {
  private readonly logins = new Map<string, LoginContext>();
  private readonly sessions = new Map<string, WebSession>();
  private readonly now: () => number;
  private readonly secure: boolean;
  private readonly origin: string;

  constructor(private readonly o: ApprovalWebOptions) {
    this.now = o.now ?? Date.now;
    this.secure = o.publicBaseUrl.startsWith("https:");
    this.origin = new URL(o.publicBaseUrl).origin;
  }

  private get redirectUri() {
    return `${this.o.publicBaseUrl}/approve/callback`;
  }

  matches(path: string) {
    return path === "/approve/callback" || path === "/approve/decision" || path.startsWith("/approve/");
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    if (req.method === "GET" && path === "/approve/callback") return this.callback(req, res, url);
    if (req.method === "POST" && path === "/approve/decision") return this.decision(req, res);
    const id = /^\/approve\/([A-Za-z0-9_-]{20,100})$/.exec(path)?.[1];
    if (req.method === "GET" && id) return this.start(res, id);
    return this.page(res, 404, messagePage("Not found", "This approval link is not valid."));
  }

  private page(res: ServerResponse, status: number, html: string, extra: Record<string, string | string[]> = {}) {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra }).end(html);
  }

  private cookie(name: string, value: string, maxAgeSeconds: number, sameSite: "Lax" | "Strict") {
    return `${name}=${value}; Path=/approve; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAgeSeconds}${this.secure ? "; Secure" : ""}`;
  }

  private start(res: ServerResponse, approvalId: string) {
    const approval = this.o.approvals.get(approvalId);
    if (approval?.status !== "pending") {
      return this.page(res, 410, messagePage("Link expired", "This approval request has expired or was already handled. Ask your assistant to try checking out again."));
    }
    this.trimLogins();
    const begin = this.o.login.begin(this.redirectUri);
    this.logins.set(begin.state, { approvalId, verifier: begin.verifier, nonce: begin.nonce, startedAt: this.now(), expires: this.now() + LOGIN_TTL_MS });
    res.writeHead(302, { location: begin.url, "set-cookie": this.cookie("ap_state", begin.state, 600, "Lax"), ...SECURITY_HEADERS }).end();
  }

  private async callback(req: IncomingMessage, res: ServerResponse, url: URL) {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    const ctx = this.logins.get(state);
    this.logins.delete(state); // one use, whatever happens next
    const bound = cookies(req).ap_state;
    if (!ctx || ctx.expires <= this.now() || !bound || !equal(bound, state) || !code) {
      return this.page(res, 400, messagePage("Sign-in failed", "The sign-in could not be completed. Open the approval link again."));
    }
    const approval = this.o.approvals.get(ctx.approvalId);
    if (approval?.status !== "pending") {
      return this.page(res, 410, messagePage("Link expired", "This approval request has expired or was already handled."));
    }
    let login: LoginResult;
    try {
      login = await this.o.login.complete({ code, verifier: ctx.verifier, nonce: ctx.nonce, redirectUri: this.redirectUri });
    } catch {
      return this.page(res, 400, messagePage("Sign-in failed", "We could not verify your sign-in."));
    }
    // Must be an interactive login that happened after the approval link was opened, not a lingering SSO session.
    if (login.authTime === undefined || login.authTime < Math.floor(ctx.startedAt / 1000) - AUTH_SKEW_SECONDS) {
      return this.page(res, 400, messagePage("Sign-in failed", "A fresh sign-in is required to approve a purchase."));
    }
    if (login.subject !== approval.subject) {
      this.o.audit.record({ event: "approval_wrong_user", sub: login.subject, approvalFor: approval.subject, azp: approval.clientId });
      return this.page(res, 403, messagePage("Wrong account", "This purchase was requested for a different account. Sign in with the account that is shopping."));
    }
    const sessionId = randomBytes(24).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    this.sessions.set(sessionId, { approvalId: approval.id, subject: login.subject, csrf, expires: this.now() + LOGIN_TTL_MS });
    this.page(res, 200, reviewPage(approval, csrf), { "set-cookie": [this.cookie("ap_session", sessionId, 600, "Strict"), this.cookie("ap_state", "", 0, "Lax")] });
  }

  private async decision(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (origin && origin !== this.origin) return this.page(res, 403, messagePage("Blocked", "Cross-site request refused."));
    const sessionId = cookies(req).ap_session;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (sessionId) this.sessions.delete(sessionId); // one decision per sign-in
    if (!session || session.expires <= this.now()) {
      return this.page(res, 403, messagePage("Session ended", "Your approval session has ended. Open the approval link again."));
    }
    const form = await readForm(req);
    if (!form || !equal(form.get("csrf") ?? "", session.csrf)) return this.page(res, 403, messagePage("Blocked", "Invalid form submission."));
    const approve = form.get("decision") === "approve";
    const outcome = this.o.approvals.decide(session.approvalId, session.subject, approve);
    if (outcome !== "ok") return this.page(res, 410, messagePage("Link expired", "This approval request has expired or was already handled."));
    this.o.audit.record({ event: approve ? "approval_granted" : "approval_denied", sub: session.subject });
    const done = { "set-cookie": this.cookie("ap_session", "", 0, "Strict") };
    if (!approve) return this.page(res, 200, messagePage("Cancelled", "Nothing was charged."), done);
    if (!this.o.placeOrder) {
      return this.page(res, 200, messagePage("Approved", "Thank you. Go back to your assistant and ask it to complete the checkout."), done);
    }
    const approval = this.o.approvals.get(session.approvalId);
    if (!approval) return this.page(res, 410, messagePage("Link expired", "This approval request has expired or was already handled."), done);
    try {
      const { orderId, totalCents } = this.o.placeOrder(approval);
      this.o.audit.record({ event: "order_placed", sub: session.subject, orderId, totalCents, via: "approval_page" });
      return this.page(
        res,
        200,
        messagePage("Order placed", `Order ${orderId} for $${(totalCents / 100).toFixed(2)} is placed. Your assistant can show it to you (list_orders).`),
        done,
      );
    } catch (err) {
      // e.g. the spend cap, or the cart changed since the request: nothing was charged.
      return this.page(res, 409, messagePage("Not placed", `Nothing was charged: ${err instanceof Error ? err.message : "the order could not be placed"}`), done);
    }
  }

  private trimLogins() {
    const t = this.now();
    for (const [k, v] of this.logins) if (v.expires <= t) this.logins.delete(k);
    for (const [k, v] of this.sessions) if (v.expires <= t) this.sessions.delete(k);
    while (this.logins.size >= MAX_PENDING_LOGINS) deleteOldest(this.logins);
  }
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | undefined> {
  if (!/^application\/x-www-form-urlencoded/i.test(req.headers["content-type"] ?? "")) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4096) return undefined;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

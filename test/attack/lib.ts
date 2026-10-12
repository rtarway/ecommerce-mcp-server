import { execFileSync } from "node:child_process";
import { loginWithPkce } from "../e2e/oauth-login.js";

export const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8000";
export const KEYCLOAK = process.env.KEYCLOAK_URL ?? "http://localhost:8080";
export const REALM_URL = `${KEYCLOAK}/realms/mcp`;
export const MCP_URL = `${GATEWAY}/mcp`;
export const USER = process.env.TEST_USER ?? "testuser";
export const PASSWORD = process.env.TEST_USER_PASSWORD ?? "";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Outcome {
  /** True when the defence held (or, for the shopper persona, the journey worked). */
  held: boolean;
  note: string;
}

export interface Scenario {
  id: string;
  persona: string;
  vector: string;
  /** What a successful attack would mean. */
  impact: string;
  run: () => Promise<Outcome>;
}

/** Raw MCP-over-HTTP client, the way a scripted agent or a hostile client would speak it. */
export class McpClient {
  sessionId?: string;
  constructor(private headers: Record<string, string> = {}) {}

  async post(body: unknown, extra: Record<string, string> = {}) {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}), ...this.headers, ...extra },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const data = /^data: (.*)$/m.exec(text)?.[1] ?? text;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  async init() {
    const r = await this.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lab", version: "1" } } });
    this.sessionId = r.headers.get("mcp-session-id") ?? undefined;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return r;
  }

  async tool(name: string, args: Record<string, unknown> = {}) {
    const r = await this.post({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method: "tools/call", params: { name, arguments: args } });
    return { ...r, structured: r.json?.result?.structuredContent as any, isError: r.json?.result?.isError as boolean | undefined, text: r.json?.result?.content?.[0]?.text as string | undefined };
  }

  /** Empties the cart this client sees (for a customer: their persistent cart) with view_cart + remove_from_cart. */
  async clearCart() {
    const items = ((await this.tool("view_cart")).structured?.cart?.items ?? []) as { productId: string }[];
    for (const i of items) await this.tool("remove_from_cart", { productId: i.productId });
  }

  withAuth(token: string, scheme = "Bearer") {
    this.headers = { ...this.headers, authorization: `${scheme} ${token}` };
    return this;
  }
}

export async function login(opts: { clientId?: string; scope: string; redirectUri?: string; pkce?: boolean; authParams?: Record<string, string> }) {
  return loginWithPkce({
    authorizationEndpoint: `${REALM_URL}/protocol/openid-connect/auth`,
    tokenEndpoint: `${REALM_URL}/protocol/openid-connect/token`,
    clientId: opts.clientId ?? "mcp-test-client",
    redirectUri: opts.redirectUri ?? "http://localhost:53682/callback",
    scope: opts.scope,
    username: USER,
    password: PASSWORD,
    pkce: opts.pkce,
    authParams: opts.authParams,
  });
}

export const SHOP_SCOPE = "openid shop:api ecommerce:checkout";

export async function refresh(clientId: string, refreshToken: string) {
  const res = await fetch(`${REALM_URL}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

export const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());

/** Minimal cookie jar + manual redirects: what a person's browser does on the approval pages. */
export class Browser {
  private jar = new Map<string, string>();
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(url, { redirect: "manual", ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers as object) } });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, ...v] = pair!.split("=");
      if (/Max-Age=0/i.test(c)) this.jar.delete(k!);
      else this.jar.set(k!, v.join("="));
    }
    return res;
  }
  async follow(url: string, init?: RequestInit, max = 8): Promise<Response> {
    let res = await this.fetch(url, init);
    for (let i = 0; i < max && res.status >= 300 && res.status < 400; i++) {
      const loc = new URL(res.headers.get("location")!, url);
      res = await this.fetch(loc.toString());
      url = loc.toString();
    }
    return res;
  }
}

const hidden = (html: string, name: string) => new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1];
const action = (html: string) => (/<form[^>]*action="([^"]+)"/.exec(html)?.[1] ?? "").replace(/&amp;/g, "&");

/** The customer opens the approval link, signs in again, reads the page, clicks Approve (or Cancel). */
export async function approveInBrowser(approvalUrl: string, decision: "approve" | "deny" = "approve", password = PASSWORD) {
  const b = new Browser();
  const start = await b.fetch(approvalUrl);
  if (start.status !== 302) return { stage: "start", status: start.status, page: "" };
  let res = await b.fetch(start.headers.get("location")!);
  const loginHtml = await res.text();
  res = await b.fetch(action(loginHtml), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: USER, password, credentialId: "" }) });
  if (res.status !== 302) return { stage: "login", status: res.status, page: await res.text() };
  const review = await b.fetch(res.headers.get("location")!);
  const html = await review.text();
  if (review.status !== 200) return { stage: "callback", status: review.status, page: html };
  const csrf = hidden(html, "csrf")!;
  // What a real browser sends as Origin on a form POST depends on the page's referrer policy (no-referrer -> "null").
  const origin = /no-referrer/i.test(review.headers.get("referrer-policy") ?? "") ? "null" : GATEWAY;
  const done = await b.fetch(`${GATEWAY}/approve/decision`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin }, body: new URLSearchParams({ csrf, decision }) });
  return { stage: "decided", status: done.status, page: html, result: await done.text() };
}

/** Runs kubectl in the throw-away probe style; returns stdout. */
export function kubectl(args: string[], input?: string) {
  return execFileSync("kubectl", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
}

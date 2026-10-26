/**
 * Attack lab: plays every class of MCP client we know of against the LIVE stack (gateway :8000, sign-in on the gateway, Keycloak admin :8080).
 *   TEST_USER_PASSWORD=… npx tsx test/attack/lab.ts [--only=A,C] [--report=docs/ATTACK-RESULTS.md] [--no-reset]
 * Restarts the shop first (in-memory state) unless --no-reset.
 * "held" = the defence stopped the attack (or, for the shopper, the journey worked with little friction).
 * Order matters: floods and the theft-response scenario go last because they rate-limit / reset the lab user.
 */
import { writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import {
  GATEWAY, KEYCLOAK, MCP_URL, McpClient, PASSWORD, REALM_URL, SHOP_SCOPE, SIGN_IN_FIRST, approveInBrowser, claims, kubectl, login, refresh, sleep,
  type Outcome, type Scenario,
} from "./lib.js";

const held = (note: string): Outcome => ({ held: true, note });
const breach = (note: string): Outcome => ({ held: false, note });

const register = async (body: object) => {
  const r = await fetch(`${REALM_URL}/clients-registrations/openid-connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ok: r.ok, client_id: r.ok ? ((await r.json()) as { client_id: string }).client_id : "" };
};

/** A signed-in customer client whose session is open and whose (persistent, 24 h) cart starts empty. */
const withToken = async (scope = SHOP_SCOPE) => {
  const t = await login({ scope });
  const client = new McpClient().withAuth(t.accessToken);
  const init = client.init.bind(client);
  client.init = async () => {
    const r = await init();
    await client.clearCart(); // earlier scenarios (thieves) leave items behind on purpose
    return r;
  };
  return { ...t, client };
};

const scenarios: Scenario[] = [
  // ───────────────────────── B. the legitimate shopper (must stay easy) ─────────────────────────
  {
    id: "B1", persona: "Legitimate shopper", vector: "Full purchase: browse → cart → sign in → approve → order",
    impact: "Shoppers cannot buy, or need too many steps",
    async run() {
      const t0 = Date.now();
      if (SIGN_IN_FIRST) {
        // Sign in on first connect: refused without a token, then one sign-in covers browsing, cart and checkout.
        const refused = await new McpClient().init();
        if (refused.status !== 401 || !/scope="[^"]*ecommerce:checkout/.test(refused.headers.get("www-authenticate") ?? "")) return breach(`connect without token: HTTP ${refused.status}`);
        const tokens = await login({ scope: SHOP_SCOPE });
        const c = new McpClient().withAuth(tokens.accessToken);
        await c.init();
        await c.clearCart();
        const search = await c.tool("product_search", { query: "running shoes" });
        const add = await c.tool("add_to_cart", { productId: "shoe-trail-001", quantity: 1 });
        if (!search.structured?.products?.length || !add.structured?.cart) return breach("signed-in browse/cart failed");
        const first = await c.tool("one_step_checkout");
        if (first.structured?.status !== "approval_required") return breach(`expected approval_required, got ${JSON.stringify(first.structured ?? first.text)}`);
        const approved = await approveInBrowser(first.structured.approvalUrl);
        if (!/Order ord_\w+ for \$[\d.]+ is placed/.test(approved.result ?? "")) return breach(`approval page flow failed at ${approved.stage} (${approved.status})`);
        const second = await c.tool("one_step_checkout");
        if (second.structured?.status !== "placed") return breach(`order not placed: ${second.text}`);
        const listed = (await c.tool("list_orders")).structured?.orders?.[0]?.orderId;
        if (listed !== second.structured.order.orderId) return breach(`list_orders does not show the new order first: ${listed}`);
        const retry = await c.tool("one_step_checkout");
        const idem = retry.structured?.order?.orderId === second.structured.order.orderId;
        return { held: idem, note: `sign-in first: connect refused without a token (401, both scopes); order ${second.structured.order.orderId} placed in ${((Date.now() - t0) / 1000).toFixed(1)}s; customer actions: 1 sign-in + 1 approval; no step-up; retry ${idem ? "returned same order (no double charge)" : "DID NOT dedupe"}` };
      }
      const anon = new McpClient();
      await anon.init();
      const search = await anon.tool("product_search", { query: "running shoes" });
      const add = await anon.tool("add_to_cart", { productId: "shoe-trail-001", quantity: 1 });
      if (!search.structured?.products?.length || !add.structured?.cart) return breach("anonymous browse/cart failed");
      const tokens = await login({ scope: SHOP_SCOPE });
      const authed = new McpClient().withAuth(tokens.accessToken);
      authed.sessionId = anon.sessionId; // same MCP session: the anonymous cart follows the customer
      const first = await authed.tool("one_step_checkout");
      if (first.structured?.status !== "approval_required") return breach(`expected approval_required, got ${JSON.stringify(first.structured ?? first.text)}`);
      const approved = await approveInBrowser(first.structured.approvalUrl);
      if (!/Order ord_\w+ for \$[\d.]+ is placed/.test(approved.result ?? "")) return breach(`approval page flow failed at ${approved.stage} (${approved.status})`);
      const second = await authed.tool("one_step_checkout");
      if (second.structured?.status !== "placed") return breach(`order not placed: ${second.text}`);
      const listed = (await authed.tool("list_orders")).structured?.orders?.[0]?.orderId;
      if (listed !== second.structured.order.orderId) return breach(`list_orders does not show the new order first: ${listed}`);
      const retry = await authed.tool("one_step_checkout");
      const idem = retry.structured?.order?.orderId === second.structured.order.orderId;
      return { held: idem, note: `order ${second.structured.order.orderId} placed in ${((Date.now() - t0) / 1000).toFixed(1)}s; customer actions: 1 sign-in + 1 click (the click places the order; list_orders shows it); retry ${idem ? "returned same order (no double charge)" : "DID NOT dedupe"}; total $${second.structured.order.total}` };
    },
  },
  {
    id: "B2", persona: "Legitimate shopper", vector: "Customer declines on the approval page",
    impact: "A refusal is ignored or the agent keeps nagging",
    async run() {
      const { client } = await withToken();
      await client.init();
      await client.tool("add_to_cart", { productId: "bottle-001", quantity: 1 });
      const first = await client.tool("one_step_checkout");
      await approveInBrowser(first.structured.approvalUrl, "deny");
      const after = await client.tool("one_step_checkout");
      return after.isError && /declined/.test(after.text ?? "") ? held("agent told the customer declined; no order") : breach(`unexpected: ${after.text}`);
    },
  },
  {
    id: "B3", persona: "Legitimate shopper", vector: "Second client for the same customer (another install, another session)",
    impact: "A normal second device is treated as an attack",
    async run() {
      const a = await withToken();
      const b = await withToken();
      await a.client.init();
      await b.client.init();
      const ra = await a.client.tool("add_to_cart", { productId: "bottle-001", quantity: 1 });
      const rb = await b.client.tool("product_search", { query: "tent" });
      return ra.structured?.cart && rb.structured?.products ? held("two simultaneous installations both work") : breach("second client blocked");
    },
  },

  {
    id: "B4", persona: "Legitimate shopper", vector: "Spots an item they did not ask for (added by a thief or a rogue agent) and removes it before approving",
    impact: "Customer has to approve the injected item or abandon the purchase",
    async run() {
      const thief = await withToken();
      await thief.client.init();
      await thief.client.tool("add_to_cart", { productId: "watch-gps-001", quantity: 1 }); // $199.99 the customer never wanted
      // The customer's own client must NOT start by clearing the cart: seeing the injected item is the point.
      const client = new McpClient().withAuth((await login({ scope: SHOP_SCOPE })).accessToken);
      await client.init();
      await client.tool("add_to_cart", { productId: "bottle-001", quantity: 1 });
      const seen = (await client.tool("view_cart")).structured?.cart?.items?.map((i: { productId: string }) => i.productId) ?? [];
      if (!seen.includes("watch-gps-001")) return breach(`view_cart did not show the injected item: ${seen}`);
      await client.tool("remove_from_cart", { productId: "watch-gps-001" });
      const pending = await client.tool("one_step_checkout");
      await approveInBrowser(pending.structured.approvalUrl);
      const order = (await client.tool("one_step_checkout")).structured?.order;
      const bought = order?.items?.map((i: { productId: string }) => i.productId) ?? [];
      return order && !bought.includes("watch-gps-001") ? held(`view_cart showed the injected watch; removed; order ${order.orderId} contains only ${bought.join(", ")} ($${order.total})`) : breach(`bought: ${bought}`);
    },
  },

  // ───────────────────────── A. anonymous bot / scripted client ─────────────────────────
  {
    id: "A1", persona: "Anonymous bot", vector: "Forged / guessed Mcp-Session-Id",
    impact: "Read or modify another visitor's cart",
    async run() {
      const c = new McpClient();
      c.sessionId = "victim-session-guess";
      const r = await c.tool("add_to_cart", { productId: "bottle-001", quantity: 1 });
      return r.status >= 400 && !r.structured ? held(`rejected with HTTP ${r.status}`) : breach(`HTTP ${r.status}`);
    },
  },
  {
    id: "A2", persona: "Anonymous bot", vector: "Spoofed trust headers (X-Forwarded-For, x-trust-tier, x-mcp-session-id, x-installation-id)",
    impact: "Forge client identity / bypass cooling-off / hijack a session through the edge",
    async run() {
      const c = SIGN_IN_FIRST ? (await withToken()).client : new McpClient();
      await c.init();
      const r = await c.tool("add_to_cart", { productId: "bottle-001", quantity: 1 }, ).catch(() => undefined);
      const spoof = await c.post(
        { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "add_to_cart", arguments: { productId: "bottle-001", quantity: 1 } } },
        { "x-mcp-session-id": "someone-elses-session-id", "x-forwarded-for": "6.6.6.6", "x-trust-tier": "normal", "x-installation-id": "x|y" },
      );
      const qty = spoof.json?.result?.structuredContent?.cart?.items?.[0]?.quantity;
      return qty === 2 && r ? held("spoofed headers were stripped; the cart stayed on our own session (qty 2 = both calls landed on one cart)") : breach(`cart qty ${qty}; status ${spoof.status}`);
    },
  },
  {
    id: "A3", persona: "Anonymous bot", vector: "Oversized request body",
    impact: "Memory exhaustion",
    async run() {
      const res = await fetch(MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "x".repeat(2_000_000) }).catch(() => undefined);
      return !res || res.status >= 400 ? held(res ? `HTTP ${res.status}` : "connection dropped") : breach(`HTTP ${res.status}`);
    },
  },
  {
    id: "A4", persona: "Malicious website", vector: "Cross-origin browser request to /mcp (preflight and simple request)",
    impact: "A web page rides the user's browser to call the shop",
    async run() {
      const pre = await fetch(MCP_URL, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" } });
      const allow = pre.headers.get("access-control-allow-origin");
      const simple = await fetch(MCP_URL, { method: "POST", headers: { origin: "http://evil.example", "content-type": "text/plain", accept: "application/json, text/event-stream" }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' });
      return allow !== "http://evil.example" && allow !== "*" && simple.status === 415 ? held(`preflight ACAO=${allow ?? "none"}; text/plain simple request → ${simple.status}`) : breach(`ACAO=${allow}, simple=${simple.status}`);
    },
  },
  {
    id: "A5", persona: "Anonymous bot", vector: "Invalid / garbage bearer token",
    impact: "Unauthenticated access to tools that need login",
    async run() {
      const c = new McpClient().withAuth("garbage");
      await c.init().catch(() => undefined);
      const r = await new McpClient().withAuth("garbage").post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
      const wa = r.headers.get("www-authenticate") ?? "";
      return r.status === 401 && /resource_metadata/.test(wa) ? held("401 with OAuth challenge (client can recover)") : breach(`HTTP ${r.status} ${wa}`);
    },
  },

  {
    id: "A6", persona: "Malicious website", vector: "DNS rebinding: a page on another site talks to the local gateway (hostile Host and Origin)",
    impact: "Remote web pages drive the local MCP server through the user's browser",
    async run() {
      const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
      // fetch() silently drops a custom Host header, so use node:http to send what a rebound browser really sends.
      const post = (headers: Record<string, string>) =>
        new Promise<number>((resolve, reject) => {
          const u = new URL(MCP_URL);
          const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": Buffer.byteLength(init), ...headers } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on("error", reject);
          req.end(init);
        });
      const rebound = await post({ host: "evil.example:8000", origin: "http://evil.example:8000" }); // layer 1: gateway hostnames
      const origin = await post({ origin: "http://evil.example:8000" }); // layer 2: server Origin allow-list (valid Host)
      return rebound === 404 && origin === 403 ? held(`rebound Host → ${rebound} at the gateway (unknown hostname); hostile Origin with a valid Host → ${origin} at the server`) : breach(`host ${rebound}, origin ${origin}`);
    },
  },
  {
    id: "A7", persona: "Token thief", vector: "Session hijack: reuse a signed-in customer's MCP session with a different account's token",
    impact: "Read or fill another customer's cart through their session",
    async run() {
      const victim = await withToken();
      await victim.client.init();
      await victim.client.tool("view_cart"); // the session is now bound to the victim
      // Another principal: a dynamically registered app (a different token family), and an anonymous caller.
      const attacker = new McpClient();
      attacker.sessionId = victim.client.sessionId;
      const anon = await attacker.tool("add_to_cart", { productId: "tent-2p-001", quantity: 1 });
      const still = await victim.client.tool("view_cart");
      const injected = (still.structured?.cart?.items ?? []).some((i: { productId: string }) => i.productId === "tent-2p-001");
      return anon.status >= 400 && !injected ? held(`anonymous use of the victim's session → HTTP ${anon.status}; victim's cart untouched`) : breach(`status ${anon.status}, injected=${injected}`);
    },
  },

  // ───────────────────────── C. token thief / compromised client ─────────────────────────
  {
    id: "A8", persona: "Anonymous bot", vector: "Connect and browse without signing in (sign-in-first deployments)",
    impact: "Unattributed traffic, scraping, anonymous carts",
    async run() {
      if (!SIGN_IN_FIRST) return held("not applicable: this deployment allows anonymous browsing (REQUIRE_SIGN_IN=false)");
      const c = new McpClient();
      const init = await c.init();
      const tool = await c.tool("product_search", { query: "bottle" });
      const header = init.headers.get("www-authenticate") ?? "";
      // A tool call without a session is refused too (by the gateway with 400 before it reaches the shop, or 401).
      const ok = init.status === 401 && !init.headers.get("mcp-session-id") && tool.status >= 400 && !tool.structured && /resource_metadata=/.test(header) && /error_description="[^"]*sign in/.test(header);
      return ok ? held(`initialize → 401 with resource metadata, both scopes and sign-in instructions, no session id; tool call → ${tool.status}, nothing returned`) : breach(`initialize ${init.status}, tool ${tool.status}`);
    },
  },
  {
    id: "C1", persona: "Token thief", vector: "Stolen access token (with checkout scope) used to buy",
    impact: "Money moves without the customer",
    async run() {
      const { client } = await withToken();
      await client.init();
      await client.tool("add_to_cart", { productId: "tent-2p-001", quantity: 1 });
      const tries = [];
      for (let i = 0; i < 4; i++) tries.push((await client.tool("one_step_checkout")).structured?.status);
      return tries.every((s) => s === "approval_required") ? held("4 attempts, 0 orders: every call stops at the human approval link") : breach(`statuses: ${tries}`);
    },
  },
  {
    id: "C2", persona: "Token thief", vector: "Thief (or injected agent) opens the approval link without the password",
    impact: "Approves the purchase on the customer's behalf",
    async run() {
      const { client } = await withToken();
      await client.init();
      await client.tool("add_to_cart", { productId: "tent-2p-001", quantity: 1 });
      const url = (await client.tool("one_step_checkout")).structured.approvalUrl as string;
      const r = await fetch(url, { redirect: "manual" });
      const to = r.headers.get("location") ?? "";
      const wrong = await approveInBrowser(url, "approve", "not-the-password");
      const still = (await client.tool("one_step_checkout")).structured?.status;
      return r.status === 302 && to.startsWith(KEYCLOAK) && wrong.stage === "login" && still === "approval_required" ? held("link only leads to Keycloak login; wrong password stops there; still unapproved") : breach(`${r.status} ${to} ${wrong.stage} ${still}`);
    },
  },
  {
    id: "C3", persona: "Token thief", vector: "Cart tampering after the customer approved (inject extra items before the agent retries)",
    impact: "Customer pays for more than they approved",
    async run() {
      const { client } = await withToken();
      await client.init();
      await client.tool("add_to_cart", { productId: "bottle-001", quantity: 1 });
      const first = await client.tool("one_step_checkout");
      await approveInBrowser(first.structured.approvalUrl, "approve");
      await client.tool("add_to_cart", { productId: "watch-gps-001", quantity: 1 });
      const r = await client.tool("one_step_checkout");
      return r.structured?.status === "approval_required" ? held("changed cart needs a fresh approval") : breach(JSON.stringify(r.structured ?? r.text));
    },
  },
  {
    id: "C4", persona: "Rogue client", vector: "Token minted without the shop audience scope (token for a different resource)",
    impact: "A token meant for another service is accepted here",
    async run() {
      // A dynamically registered client that (like any other app on the realm) never asked for the shop's audience scope.
      const reg = await register({ client_name: "other-app", redirect_uris: ["http://localhost:53997/cb"], token_endpoint_auth_method: "none" });
      if (!reg.ok) return breach(`could not register a client: HTTP ${reg.status} (legitimate registrations must work)`);
      const client_id = reg.client_id;
      const t = await login({ clientId: client_id, redirectUri: "http://localhost:53997/cb", scope: "openid ecommerce:checkout" });
      const aud = claims(t.accessToken).aud;
      const c = new McpClient().withAuth(t.accessToken);
      const r = await c.post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "product_search", arguments: {} } }, { "mcp-session-id": "x" });
      const init = await new McpClient().withAuth(t.accessToken).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
      const scope = /scope="([^"]+)"/.exec(init.headers.get("www-authenticate") ?? "")?.[1] ?? "";
      return init.status === 401 && /shop:api/.test(scope) && r.status !== 200 ? held(`aud=${JSON.stringify(aud)} → 401; challenge tells the client to ask for "${scope}"`) : breach(`init ${init.status}, aud ${JSON.stringify(aud)}`);
    },
  },

  // ───────────────────────── D. rogue client registrations (DCR) ─────────────────────────
  {
    id: "D1", persona: "Rogue client", vector: "Dynamic registration with a redirect to an attacker's host",
    impact: "Authorization codes delivered to the attacker",
    async run() {
      const r = await fetch(`${REALM_URL}/clients-registrations/openid-connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Evil", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }) });
      return r.status >= 400 && r.status < 500 ? held(`registration refused (HTTP ${r.status})`) : breach("evil.example redirect registered");
    },
  },
  {
    id: "D2", persona: "Rogue client", vector: "Registered public client skips PKCE (code interception)",
    impact: "Authorization-code theft by another local app",
    async run() {
      const reg = await register({ client_name: "no-pkce", redirect_uris: ["http://localhost:53999/cb"], token_endpoint_auth_method: "none" });
      if (!reg.ok) return breach(`could not register: HTTP ${reg.status}`);
      const client_id = reg.client_id;
      try {
        await login({ clientId: client_id, redirectUri: "http://localhost:53999/cb", scope: "openid", pkce: false });
        return breach("authorization code issued without PKCE");
      } catch (e) {
        return held(`login refused without PKCE: ${String(e).slice(0, 120)}`);
      }
    },
  },
  {
    id: "D3", persona: "Rogue client", vector: "Registers naming offline_access (as Inspector and most clients do) to get a long-lived refresh token",
    impact: "Stolen refresh token lives for months",
    async run() {
      const reg = await register({ client_name: "offline-seeker", redirect_uris: ["http://localhost:53998/cb"], token_endpoint_auth_method: "none", scope: "openid offline_access shop:api ecommerce:checkout" });
      if (!reg.ok) return breach(`legitimate registration naming offline_access failed: HTTP ${reg.status} (breaks Inspector)`);
      const t = await login({ clientId: reg.client_id, redirectUri: "http://localhost:53998/cb", scope: "openid offline_access shop:api ecommerce:checkout" });
      const rt = claims(t.refreshToken!);
      const days = (rt.exp - rt.iat) / 86400;
      // Granted on purpose (clients need persistent login). Bounded: idle 7d, hard max 30d, rotation with reuse detection,
      // and a stolen refresh token still cannot spend money without the customer's approval.
      return days <= 7 ? held(`offline token granted (typ ${rt.typ}) but idle-bounded to ${days.toFixed(0)} d, hard max 30 d; reuse is detected (H1); spending still needs approval (C1)`) : breach(`offline token valid ${days.toFixed(0)} d`);
    },
  },
  {
    id: "D4", persona: "Rogue client", vector: "Consent phishing: register a look-alike called \"MCP Inspector\" with Inspector's metadata URL",
    impact: "User consents to an app they believe is a known one",
    async run() {
      const r = await fetch(`${REALM_URL}/clients-registrations/openid-connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "MCP Inspector", client_uri: "https://github.com/modelcontextprotocol/inspector", redirect_uris: ["http://localhost:6274/oauth/callback"], token_endpoint_auth_method: "none" }) });
      if (r.status >= 500) return breach(`registration errored (HTTP ${r.status})`);
      return r.ok ? breach("look-alike REGISTERED. Residual risk: DCR cannot verify who is registering. Mitigations that remain: consent + per-purchase approval (money still needs the human); production must disable anonymous DCR / use CIMD with a verified publisher domain") : held(`refused (${r.status})`);
    },
  },
  {
    id: "D5", persona: "Rogue client", vector: "Resource-owner password grant against Keycloak with the customer's password",
    impact: "Client collects passwords directly",
    async run() {
      const r = await fetch(`${REALM_URL}/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", client_id: "mcp-test-client", username: "testuser", password: PASSWORD, scope: "openid" }) });
      return r.status >= 400 ? held(`HTTP ${r.status}`) : breach("password grant accepted");
    },
  },

  // ───────────────────────── E. browser-level attacks on the approval page ─────────────────────────
  {
    id: "E1", persona: "Malicious website", vector: "Forged/cross-site POST to the approval decision endpoint",
    impact: "Approve a purchase via CSRF",
    async run() {
      const a = await fetch(`${GATEWAY}/approve/decision`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://evil.example" }, body: "csrf=x&decision=approve" });
      const b = await fetch(`${GATEWAY}/approve/decision`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "csrf=x&decision=approve" });
      return a.status === 403 && b.status === 403 ? held("cross-origin and cookie-less posts both 403") : breach(`${a.status}/${b.status}`);
    },
  },
  {
    id: "E2", persona: "Malicious website", vector: "Clickjacking: frame the approval page",
    impact: "User tricked into clicking Approve",
    async run() {
      const { client } = await withToken();
      await client.init();
      await client.tool("add_to_cart", { productId: "bottle-001", quantity: 1 });
      const url = (await client.tool("one_step_checkout")).structured.approvalUrl as string;
      const r = await fetch(url, { redirect: "manual" });
      const xfo = r.headers.get("x-frame-options");
      const csp = r.headers.get("content-security-policy") ?? "";
      return xfo === "DENY" && /frame-ancestors 'none'/.test(csp) ? held("X-Frame-Options: DENY + CSP frame-ancestors 'none'") : breach(`xfo=${xfo} csp=${csp}`);
    },
  },

  // ───────────────────────── F. attacker inside the cluster ─────────────────────────
  {
    id: "F1", persona: "In-cluster attacker", vector: "Bypass the gateway from a pod in another namespace (forged session + client address)",
    impact: "Unauthenticated access to the shop and forged client identity",
    async run() {
      // Run the probe pod to completion and read its logs: `kubectl run -i` can miss the output of a short-lived pod.
      const pod = `lab-probe-${Date.now() % 100000}`;
      kubectl(["run", pod, "--restart=Never", "--image=curlimages/curl:8.11.1", "--command", "--", "sh", "-c",
        `curl -s -m 6 -o /dev/null -w "shop=%{http_code} " -X POST http://ecommerce-mcp-server.mcp-servers.svc.cluster.local/mcp -H 'Content-Type: application/json' -H 'x-forwarded-for: 1.2.3.4' -H 'mcp-session-id: victim' -d '{}'; ` +
        `curl -s -m 6 -o /dev/null -w "sm=%{http_code}" http://session-manager.mcp-servers.svc.cluster.local/check; true`]);
      let out = "";
      try {
        kubectl(["wait", "--for=jsonpath={.status.phase}=Succeeded", `pod/${pod}`, "--timeout=90s"]);
        out = kubectl(["logs", pod]);
      } finally {
        kubectl(["delete", "pod", pod, "--now"]);
      }
      return /shop=000/.test(out) && /sm=000/.test(out) ? held(out.trim()) : breach(out.trim());
    },
  },

  // ───────────────────────── G. floods and the theft response (run last) ─────────────────────────
  {
    id: "G1", persona: "Anonymous bot", vector: "Session flood: 150 initialize calls in a burst",
    impact: "Memory exhaustion / denial of service for real shoppers",
    async run() {
      if (SIGN_IN_FIRST) {
        // Without a token nothing is created at all; with one, the per-address initialize limit still applies.
        const anon = await Promise.all(Array.from({ length: 150 }, () => new McpClient().post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "f", version: "1" } } }).then((r) => r.status)));
        const { accessToken } = await login({ scope: SHOP_SCOPE });
        const signed = await Promise.all(Array.from({ length: 150 }, () => new McpClient().withAuth(accessToken).post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "f", version: "1" } } }).then((r) => r.status)));
        await sleep(65_000);
        const anonRefused = anon.every((c) => c === 401 || c === 429);
        const limited = signed.filter((c) => c === 429).length;
        return anonRefused && limited > 0 ? held(`no token: all 150 refused (401/429), no session created; signed in: ${signed.filter((c) => c === 200).length} accepted, ${limited} rate-limited`) : breach(`no token: ${anon.filter((c) => c === 200).length} sessions created; signed in: ${limited} limited`);
      }
      const codes = await Promise.all(Array.from({ length: 150 }, () => new McpClient().post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "f", version: "1" } } }).then((r) => r.status)));
      const ok = codes.filter((c) => c === 200).length;
      const limited = codes.filter((c) => c === 429).length;
      await sleep(65_000); // let the per-minute windows clear before the next scenario
      return limited > 0 && ok < 150 ? held(`${ok} accepted, ${limited} rate-limited (429)`) : breach(`${ok} accepted, ${limited} limited`);
    },
  },
  {
    id: "H1", persona: "Token thief", vector: "Stolen REFRESH token replayed after the real client rotated it",
    impact: "Attacker keeps the customer's session alive indefinitely",
    async run() {
      const t = await login({ scope: SHOP_SCOPE });
      const rt1 = t.refreshToken!;
      const legit = await refresh("mcp-test-client", rt1); // the real client refreshes: rt1 is now spent
      if (legit.status !== 200) return breach(`legit refresh failed: ${JSON.stringify(legit.body)}`);
      const live = new McpClient().withAuth(legit.body.access_token);
      const before = await live.init();
      const stolen = await refresh("mcp-test-client", rt1); // thief replays the old one
      if (stolen.status === 200) return breach("rotated refresh token was accepted again");
      let denied = false;
      let after = 0;
      for (let i = 0; i < 12 && !denied; i++) {
        await sleep(5000);
        const c = new McpClient().withAuth(legit.body.access_token);
        after = (await c.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } })).status;
        denied = after === 401;
      }
      const rt2 = await refresh("mcp-test-client", legit.body.refresh_token);
      return denied && rt2.status !== 200 ? held(`before: HTTP ${before.status}; thief's replay rejected by Keycloak; within ${denied ? "≤60s" : "—"} the session-manager ended the customer's sessions (access token → 401, legit refresh → ${rt2.status}); only a fresh login gets back in`) : breach(`denied=${denied} lastStatus=${after} legitRefresh=${rt2.status}`);
    },
  },
  {
    id: "H2", persona: "Legitimate shopper", vector: "After a theft reset the real customer signs in again",
    impact: "Recovery locks the real customer out",
    async run() {
      const { client } = await withToken();
      const init = await client.init();
      await client.tool("add_to_cart", { productId: "bottle-001", quantity: 1 });
      const r = await client.tool("one_step_checkout");
      const wait = r.isError && /new|shortly/i.test(r.text ?? "") ? "checkout held back during the incident window (cooling-off)" : r.structured?.status === "approval_required" ? "checkout proceeds to approval" : JSON.stringify(r.structured ?? r.text);
      return init.status === 200 ? held(`sign-in works again; browsing OK; ${wait}`) : breach(`init ${init.status}`);
    },
  },
];

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const reportPath = process.argv.find((a) => a.startsWith("--report="))?.slice(9);

if (!PASSWORD) {
  console.error("Set TEST_USER_PASSWORD (terraform -chdir=<infra>/terraform output -raw test_user_password)");
  process.exit(2);
}

// Carts and orders are in memory (POC) and customer carts live 24 h, so leftovers from a previous run (the theft
// scenarios fill carts and never buy) would push the shopper over the spend cap. Start from a clean shop.
if (!process.argv.includes("--no-reset")) {
  kubectl(["-n", "mcp-servers", "rollout", "restart", "deploy/ecommerce-mcp-server"]);
  kubectl(["-n", "mcp-servers", "rollout", "status", "deploy/ecommerce-mcp-server", "--timeout=120s"]);
  await sleep(5000);
}

const rows: string[] = [];
let breaches = 0;
for (const s of scenarios) {
  if (only && !only.includes(s.id[0]!) && !only.includes(s.id)) continue;
  let outcome: Outcome;
  try {
    outcome = await s.run();
  } catch (err) {
    outcome = { held: false, note: `scenario error: ${err instanceof Error ? err.message : err}` };
  }
  if (!outcome.held) breaches++;
  const mark = outcome.held ? "HELD    " : "GOT THRU";
  console.log(`${mark} ${s.id.padEnd(3)} ${s.persona} — ${s.vector}\n         ${outcome.note}`);
  rows.push(`| ${s.id} | ${s.persona} | ${s.vector} | ${s.impact} | ${outcome.held ? "✅ held" : "⚠️ got through"} | ${outcome.note.replace(/\|/g, "/")} |`);
}
console.log(`\n${scenarios.length - breaches >= 0 ? rows.length - breaches : 0}/${rows.length} held, ${breaches} got through`);
if (reportPath) {
  writeFileSync(reportPath, `# Attack lab results\n\nGenerated ${new Date().toISOString()} against the live local stack by \`test/attack/lab.ts\`.\n\n| # | Persona | Attack | Impact if it worked | Result | Evidence |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n`);
  console.log(`report written to ${reportPath}`);
}
process.exit(breaches ? 1 : 0);

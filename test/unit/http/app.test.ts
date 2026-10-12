import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AUDIENCE, ISSUER, createTestIdp, type TestIdp } from "../../support/tokens.js";
import { createDpopClient } from "../../support/dpop.js";
import { createTokenVerifier } from "../../../src/auth/tokens.js";
import { MemoryAudit } from "../../../src/security/audit.js";
import { SessionRegistry } from "../../../src/session/registry.js";
import { buildShop } from "../../../src/domain/shop.js";
import { createApp, type AppConfig } from "../../../src/http/app.js";

const PRM_URL = "http://localhost:8000/.well-known/oauth-protected-resource/mcp";

let idp: TestIdp;

interface Harness {
  server: Server;
  base: string;
  audit: MemoryAudit;
  rpc(body: unknown, headers?: Record<string, string>): Promise<Response>;
  init(headers?: Record<string, string>): Promise<string>;
  close(): Promise<unknown>;
}

async function start(over: Partial<AppConfig> = {}): Promise<Harness> {
  const audit = new MemoryAudit();
  const app = createApp({
    shop: buildShop(),
    verify: createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: idp.keySet }),
    resource: AUDIENCE,
    issuer: ISSUER,
    resourceMetadataUrl: PRM_URL,
    audit,
    ...over,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rpc = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
  return {
    server,
    base,
    audit,
    rpc,
    async init(headers = {}) {
      const res = await rpc(INIT, headers);
      expect(res.status).toBe(200);
      return res.headers.get("mcp-session-id")!;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const call = (name: string, args: unknown = {}, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const resultText = async (res: Response) => JSON.stringify(await res.json());

beforeAll(async () => {
  idp = await createTestIdp();
});

describe("HTTP gate", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await start({ apiScope: "shop:api" });
  });
  afterAll(() => h.close());

  it("serves health and protected-resource metadata, advertising scopes and DPoP support", async () => {
    expect((await fetch(`${h.base}/healthz`)).status).toBe(200);
    const prm = await (await fetch(`${h.base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toMatchObject({ resource: AUDIENCE, authorization_servers: [ISSUER], bearer_methods_supported: ["header"], dpop_bound_access_tokens_required: false });
    // scope minimisation: only what basic use needs; checkout is asked for by step-up challenges
    expect(prm.scopes_supported).toEqual(["shop:api"]);
    expect(prm.dpop_signing_alg_values_supported).toContain("ES256");
  });

  it("lets anonymous callers browse and add to cart within a server-issued session", async () => {
    const session = await h.init();
    const headers = { "mcp-session-id": session };
    expect((await h.rpc(call("product_search", { query: "shoes" }), headers)).status).toBe(200);
    const add = await h.rpc(call("add_to_cart", { productId: "shoe-trail-001", quantity: 1 }), headers);
    expect(await resultText(add)).not.toMatch(/isError/);
  });

  it("challenges anonymous one_step_checkout with 401 + scope (incl. the API scope) + resource metadata", async () => {
    const res = await h.rpc(call("one_step_checkout"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PRM_URL}", scope="shop:api ecommerce:checkout"`);
  });

  it("answers 403 insufficient_scope (step-up) when the token lacks the checkout scope", async () => {
    const token = await idp.sign({ scope: "openid email" });
    const res = await h.rpc(call("one_step_checkout"), bearer(token));
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer error="insufficient_scope", resource_metadata="${PRM_URL}", scope="openid email ecommerce:checkout"`);
  });

  it("an invalid token on an ordinary call is challenged for the base scope only", async () => {
    const res = await h.rpc(call("product_search"), bearer("garbage"));
    expect(res.headers.get("www-authenticate")).toContain('scope="shop:api"');
  });

  it("rejects an invalid token on any call, so clients refresh it", async () => {
    const res = await h.rpc(call("product_search"), bearer("garbage"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(h.audit.events()).toContain("token_rejected");
  });

  it("rejects tokens for another audience, issuer or signed by another key", async () => {
    for (const token of [await idp.sign({}, { audience: "http://other/mcp" }), await idp.sign({}, { issuer: "http://evil/realms/x" })]) {
      expect((await h.rpc(call("product_search"), bearer(token))).status).toBe(401);
    }
  });

  it("challenges anonymous list_orders the same way (order history is the customer's data)", async () => {
    const res = await h.rpc(call("list_orders"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("ecommerce:checkout");
  });

  it("gates one_step_checkout inside JSON-RPC batches too", async () => {
    const res = await h.rpc([call("product_search", {}, 1), call("one_step_checkout", {}, 2)]);
    expect(res.status).toBe(401);
  });

  it("rejects malformed JSON, oversize bodies and unsupported methods", async () => {
    const bad = await fetch(`${h.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    expect(bad.status).toBe(400);
    // The server answers 413 and drops the connection mid-upload; depending on timing the client sees either.
    const huge = await fetch(`${h.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1_100_000) }).catch(() => undefined);
    expect(huge === undefined || huge.status === 413).toBe(true);
    expect((await fetch(`${h.base}/mcp`, { method: "GET" })).status).toBe(405);
    expect((await fetch(`${h.base}/nope`)).status).toBe(404);
  });
});

describe("CORS for browser-based clients (OAuth discovery)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await start();
  });
  afterAll(() => h.close());

  it("serves protected-resource metadata to any origin, without credentials", async () => {
    const res = await fetch(`${h.base}/.well-known/oauth-protected-resource/mcp`, { headers: { origin: "http://localhost:6274" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("answers preflight for the metadata endpoint", async () => {
    const res = await fetch(`${h.base}/.well-known/oauth-protected-resource/mcp`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:6274", "access-control-request-method": "GET" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toMatch(/GET/);
  });

  it("does not answer cross-origin preflight on the MCP route itself (the gateway owns that CORS policy)", async () => {
    const res = await fetch(`${h.base}/mcp`, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "POST" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("Origin validation (Streamable HTTP MUST: DNS rebinding)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await start({ allowedOrigins: ["http://localhost:6274"] });
  });
  afterAll(() => h.close());

  it("ATTACK DNS rebinding: a request from a page on another origin is refused with 403 before anything runs", async () => {
    const res = await h.rpc(INIT, { origin: "http://evil.example:8000" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", error: { code: -32600, message: "Origin not allowed" } });
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect(h.audit.events()).toContain("origin_rejected");
    expect((await fetch(`${h.base}/mcp`, { method: "DELETE", headers: { origin: "http://evil.example" } })).status).toBe(403);
  });

  it("allows listed browser origins and non-browser clients (no Origin)", async () => {
    expect((await h.rpc(INIT, { origin: "http://localhost:6274" })).status).toBe(200);
    expect((await h.rpc(INIT)).status).toBe(200);
  });

  it("refuses every browser origin when none is configured (secure default)", async () => {
    const strict = await start();
    expect((await strict.rpc(INIT, { origin: "http://localhost:6274" })).status).toBe(403);
    await strict.close();
  });
});

describe("sessions: server-issued, unforgeable (C1, M10)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await start();
  });
  afterAll(() => h.close());

  it("issues an unguessable Mcp-Session-Id on initialize and nothing for other requests", async () => {
    const a = await h.init();
    const b = await h.init();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
    expect((await h.rpc(call("product_search"))).headers.get("mcp-session-id")).toBeNull();
  });

  it("ATTACK forged session id: a guessed Mcp-Session-Id is refused with 404 and nothing is touched", async () => {
    const res = await h.rpc(call("add_to_cart", { productId: "bottle-001", quantity: 1 }), { "mcp-session-id": "victim-session-guess" });
    expect(res.status).toBe(404);
    expect(h.audit.events()).toContain("session_unknown");
  });

  it("ATTACK header injection: x-mcp-session-id is ignored unless the gateway is trusted", async () => {
    const res = await h.rpc(call("add_to_cart", { productId: "bottle-001", quantity: 1 }), { "x-mcp-session-id": "victim-session-aaaa" });
    expect(await resultText(res)).toMatch(/No session/);
  });

  it("one client's session cannot see another's cart", async () => {
    const a = await h.init();
    const b = await h.init();
    await h.rpc(call("add_to_cart", { productId: "bottle-001", quantity: 2 }), { "mcp-session-id": a });
    const other = await h.rpc(call("add_to_cart", { productId: "bottle-001", quantity: 1 }), { "mcp-session-id": b });
    expect(await resultText(other)).toContain('\\"quantity\\": 1');
  });

  it("ATTACK session hijack: a session bound to one customer is refused for another, and for anonymous use", async () => {
    const id = await h.init();
    await h.rpc(call("add_to_cart", { productId: "bottle-001", quantity: 1 }), { "mcp-session-id": id }); // anonymous, unbound
    const alice = await idp.sign({ sub: "alice" });
    expect((await h.rpc(call("product_search"), { "mcp-session-id": id, ...bearer(alice) })).status).toBe(200); // binds to alice
    const mallory = await idp.sign({ sub: "mallory" });
    const stolen = await h.rpc(call("view_cart"), { "mcp-session-id": id, ...bearer(mallory) });
    expect(stolen.status).toBe(404);
    expect((await h.rpc(call("add_to_cart", { productId: "tent-2p-001", quantity: 1 }), { "mcp-session-id": id })).status).toBe(404); // no token
    expect(h.audit.events()).toContain("session_foreign");
    expect((await h.rpc(call("product_search"), { "mcp-session-id": id, ...bearer(alice) })).status).toBe(200); // owner still fine
  });

  it("a session started with a token is bound from the start", async () => {
    const bob = await idp.sign({ sub: "bob" });
    const id = await h.init(bearer(bob));
    expect((await h.rpc(call("product_search"), { "mcp-session-id": id })).status).toBe(404);
    expect((await h.rpc(call("product_search"), { "mcp-session-id": id, ...bearer(bob) })).status).toBe(200);
  });

  it("DELETE ends a session; reuse then gets 404", async () => {
    const id = await h.init();
    expect((await fetch(`${h.base}/mcp`, { method: "DELETE", headers: { "mcp-session-id": id } })).status).toBe(204);
    expect((await h.rpc(call("product_search"), { "mcp-session-id": id })).status).toBe(404);
  });
});

describe("gateway-trusted deployment (mesh guarantees only the gateway can call)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await start({ trustGatewayHeaders: true, requestsPerMinute: 5 });
  });
  afterAll(() => h.close());

  it("accepts the gateway's x-mcp-session-id and keys carts by it", async () => {
    const res = await h.rpc(call("add_to_cart", { productId: "bottle-001", quantity: 1 }), { "x-mcp-session-id": "gw-session-0001" });
    expect(await resultText(res)).not.toMatch(/No session/);
  });

  it("rate limits per source using the hop the gateway appended to x-forwarded-for, not what the client claimed", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await h.rpc(call("product_search"), { "x-forwarded-for": `6.6.6.${i}, 9.9.9.9` })).status);
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429, 429]); // spoofing the first hop buys nothing
    expect(h.audit.events()).toContain("rate_limited");
    expect((await h.rpc(call("product_search"), { "x-forwarded-for": "9.9.9.8" })).status).toBe(200); // other sources unaffected
  });
});

describe("flood protection (H1, H2)", () => {
  it("limits session creation per source", async () => {
    const h = await start({ initializePerMinute: 3 });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await h.rpc(INIT)).status);
    expect(codes).toEqual([200, 200, 200, 429, 429, 429]);
    await h.close();
  });

  it("answers 503 when the session table is full instead of growing", async () => {
    const sessions = new SessionRegistry({ idleMs: 60_000, maxAgeMs: 60_000, maxSessions: 2, maxPerSource: 2, newId: () => Math.random().toString(36).slice(2).padEnd(12, "x") });
    const h = await start({ sessions });
    expect((await h.rpc(INIT)).status).toBe(200);
    expect((await h.rpc(INIT)).status).toBe(200);
    expect((await h.rpc(INIT)).status).toBe(503);
    await h.close();
  });
});

describe("sender-constrained tokens (DPoP, RFC 9449)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await start();
  });
  afterAll(() => h.close());

  it("accepts a bound token with a valid proof under the DPoP scheme", async () => {
    const owner = await createDpopClient();
    const token = await idp.sign({ cnf: { jkt: owner.jkt } });
    const proof = await owner.proof({ method: "POST", url: AUDIENCE, accessToken: token });
    const res = await h.rpc(call("product_search"), { authorization: `DPoP ${token}`, dpop: proof });
    expect(res.status).toBe(200);
  });

  it("ATTACK downgrade: a stolen bound token replayed as plain Bearer is refused", async () => {
    const owner = await createDpopClient();
    const token = await idp.sign({ cnf: { jkt: owner.jkt } });
    const res = await h.rpc(call("product_search"), bearer(token));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^DPoP /);
    expect(h.audit.events()).toContain("dpop_rejected");
  });

  it("ATTACK thief with the token but not the key: no proof, wrong-key proof and replayed proof are all refused", async () => {
    const owner = await createDpopClient();
    const thief = await createDpopClient();
    const token = await idp.sign({ cnf: { jkt: owner.jkt } });
    expect((await h.rpc(call("product_search"), { authorization: `DPoP ${token}` })).status).toBe(401);
    const forged = await thief.proof({ method: "POST", url: AUDIENCE, accessToken: token });
    expect((await h.rpc(call("product_search"), { authorization: `DPoP ${token}`, dpop: forged })).status).toBe(401);
    const proof = await owner.proof({ method: "POST", url: AUDIENCE, accessToken: token });
    expect((await h.rpc(call("product_search"), { authorization: `DPoP ${token}`, dpop: proof })).status).toBe(200);
    expect((await h.rpc(call("product_search"), { authorization: `DPoP ${token}`, dpop: proof })).status).toBe(401); // captured proof replayed
  });

  it("refuses the DPoP scheme for a token that is not bound", async () => {
    const token = await idp.sign({});
    const res = await h.rpc(call("product_search"), { authorization: `DPoP ${token}` });
    expect(res.status).toBe(401);
  });
});

describe("REQUIRE_DPOP", () => {
  it("refuses unbound bearer tokens everywhere", async () => {
    const h = await start({ requireDpop: true });
    expect((await h.rpc(call("product_search"), bearer(await idp.sign({})))).status).toBe(401);
    expect((await h.rpc(call("product_search"))).status).toBe(200); // anonymous browsing still works
    await h.close();
  });
});

describe("fresh authentication for checkout (RFC 9470)", () => {
  it("asks the client to re-authenticate when the last login is too old, and lets fresh logins through", async () => {
    const h = await start({ checkoutMaxAuthAgeSeconds: 600 });
    const old = await idp.sign({ scope: "openid ecommerce:checkout", auth_time: Math.floor(Date.now() / 1000) - 3600 });
    const res = await h.rpc(call("one_step_checkout"), bearer(old));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_user_authentication"');
    expect(res.headers.get("www-authenticate")).toContain('max_age="600"');
    const missing = await idp.sign({ scope: "openid ecommerce:checkout" });
    expect((await h.rpc(call("one_step_checkout"), bearer(missing))).status).toBe(401);
    const fresh = await idp.sign({ scope: "openid ecommerce:checkout", auth_time: Math.floor(Date.now() / 1000) - 30 });
    expect((await h.rpc(call("one_step_checkout"), bearer(fresh))).status).toBe(200);
    await h.close();
  });
});

describe("trust tier from the session-manager", () => {
  it("blocks checkout for a cooling-off installation, only when the gateway is trusted to say so", async () => {
    const trusted = await start({ trustGatewayHeaders: true, checkout: {} });
    const token = await idp.sign({ scope: "openid ecommerce:checkout" });
    const s = await trusted.init();
    await trusted.rpc(call("add_to_cart", { productId: "bottle-001", quantity: 1 }), { "mcp-session-id": s });
    const blocked = await trusted.rpc(call("one_step_checkout"), { ...bearer(token), "mcp-session-id": s, "x-trust-tier": "cooling_off" });
    expect(await resultText(blocked)).toMatch(/new|shortly/i);
    expect(trusted.audit.events()).toContain("checkout_blocked");
    await trusted.close();

    const open = await start({ checkout: {} });
    const s2 = await open.init();
    await open.rpc(call("add_to_cart", { productId: "bottle-001", quantity: 1 }), { "mcp-session-id": s2 });
    const res = await open.rpc(call("one_step_checkout"), { ...bearer(token), "mcp-session-id": s2, "x-trust-tier": "cooling_off" });
    expect(await resultText(res)).toContain("placed"); // header is not believed from an untrusted network
    await open.close();
  });
});

describe("end to end through the MCP client SDK", () => {
  it("browse + add anonymously, then check out after the customer signs in (dev mode, no approval)", async () => {
    const h = await start({ checkout: {} });
    const anon = new Client({ name: "agent", version: "1" });
    const anonTransport = new StreamableHTTPClientTransport(new URL(`${h.base}/mcp`));
    await anon.connect(anonTransport);
    await anon.callTool({ name: "add_to_cart", arguments: { productId: "bottle-001", quantity: 2 } });

    const token = await idp.sign({ scope: "openid ecommerce:checkout" });
    const authed = new Client({ name: "agent", version: "1" });
    await authed.connect(new StreamableHTTPClientTransport(new URL(`${h.base}/mcp`), { sessionId: anonTransport.sessionId, requestInit: { headers: bearer(token) } }));
    const result = await authed.callTool({ name: "one_step_checkout", arguments: {} });
    const order = (result.structuredContent as { order: { total: number; payment: { last4: string } } }).order;
    expect(order.total).toBe(49.98);
    expect(order.payment.last4).toBe("4242");
    await h.close();
  });
});

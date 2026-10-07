import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AUDIENCE, ISSUER, createTestIdp, type TestIdp } from "../../test/support/tokens.js";
import { createTokenVerifier } from "../auth/tokens.js";
import { buildShop } from "../shop.js";
import { createApp } from "./app.js";

const PRM_URL = "http://localhost:8000/.well-known/oauth-protected-resource/mcp";

let idp: TestIdp;
let server: Server;
let base: string;

beforeAll(async () => {
  idp = await createTestIdp();
  const app = createApp({
    shop: buildShop(),
    verify: createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet: idp.keySet }),
    resource: AUDIENCE,
    issuer: ISSUER,
    resourceMetadataUrl: PRM_URL,
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
const call = (name: string, args: unknown = {}, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const withSession = { "mcp-session-id": "sess-1" };

describe("HTTP gate", () => {
  it("serves health and protected-resource metadata", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toMatchObject({ resource: AUDIENCE, authorization_servers: [ISSUER], bearer_methods_supported: ["header"] });
    expect(prm.scopes_supported).toContain("ecommerce:checkout");
  });

  it("lets anonymous callers browse and add to cart", async () => {
    const search = await rpc(call("product_search", { query: "shoes" }), withSession);
    expect(search.status).toBe(200);
    const add = await rpc(call("add_to_cart", { productId: "shoe-trail-001", quantity: 1 }), withSession);
    expect(add.status).toBe(200);
  });

  it("challenges anonymous one_step_checkout with 401 + scope + resource metadata", async () => {
    const res = await rpc(call("one_step_checkout"), withSession);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PRM_URL}", scope="ecommerce:checkout"`);
  });

  it("answers 403 insufficient_scope (step-up) when the token lacks the checkout scope", async () => {
    const token = await idp.sign({ scope: "openid email" });
    const res = await rpc(call("one_step_checkout"), { ...withSession, authorization: `Bearer ${token}` });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer error="insufficient_scope", resource_metadata="${PRM_URL}", scope="openid email ecommerce:checkout"`,
    );
  });

  it("rejects an invalid token on any call, so clients refresh it", async () => {
    const res = await rpc(call("product_search"), { authorization: "Bearer garbage" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("gates one_step_checkout inside JSON-RPC batches too", async () => {
    const res = await rpc([call("product_search", {}, 1), call("one_step_checkout", {}, 2)], withSession);
    expect(res.status).toBe(401);
  });

  it("rejects malformed JSON and unsupported methods", async () => {
    const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/mcp`, { method: "GET" })).status).toBe(405);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe("CORS for browser-based clients (OAuth discovery)", () => {
  it("serves protected-resource metadata to any origin, without credentials", async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, { headers: { origin: "http://localhost:6274" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("answers preflight for the metadata endpoint", async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:6274", "access-control-request-method": "GET" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toMatch(/GET/);
  });
});

describe("server-issued sessions", () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

  it("issues an unguessable Mcp-Session-Id on initialize", async () => {
    const a = (await rpc(init)).headers.get("mcp-session-id");
    const b = (await rpc(init)).headers.get("mcp-session-id");
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it("does not issue a session for other requests", async () => {
    expect((await rpc(call("product_search"))).headers.get("mcp-session-id")).toBeNull();
  });
});

describe("session identity from the gateway", () => {
  it("keys anonymous carts by the gateway-provided x-mcp-session-id (the gateway terminates Mcp-Session-Id)", async () => {
    const hdr = { "x-mcp-session-id": "gw-session-1" };
    const add = await rpc(call("add_to_cart", { productId: "bottle-001", quantity: 1 }), hdr);
    expect(add.status).toBe(200);
    const body = JSON.stringify(await add.json());
    expect(body).not.toMatch(/No session/);
  });

  it("prefers the gateway header over a client-sent Mcp-Session-Id", async () => {
    const res = await rpc(call("add_to_cart", { productId: "bottle-001", quantity: 1 }), {
      "x-mcp-session-id": "gw-session-2",
      "mcp-session-id": "client-claimed",
    });
    expect(JSON.stringify(await res.json())).not.toMatch(/No session/);
  });
});

describe("end to end through the MCP client SDK", () => {
  it("browse + add anonymously, then check out after the customer signs in", async () => {
    const sessionHeaders = { "mcp-session-id": "e2e-session" };
    const anon = new Client({ name: "agent", version: "1" });
    await anon.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: sessionHeaders } }));
    await anon.callTool({ name: "add_to_cart", arguments: { productId: "bottle-001", quantity: 2 } });

    const token = await idp.sign({ scope: "openid ecommerce:checkout" });
    const authed = new Client({ name: "agent", version: "1" });
    await authed.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { ...sessionHeaders, authorization: `Bearer ${token}` } },
      }),
    );
    const result = await authed.callTool({ name: "one_step_checkout", arguments: {} });
    const order = (result.structuredContent as { order: { total: number; payment: { last4: string } } }).order;
    expect(order.total).toBe(49.98);
    expect(order.payment.last4).toBe("4242");
  });
});

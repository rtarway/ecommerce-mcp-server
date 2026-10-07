import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InvalidTokenError, bearerToken, type Identity } from "../auth/tokens.js";
import { wwwAuthenticate } from "../auth/challenge.js";
import { CHECKOUT_SCOPE, createShopServer } from "../mcp/server.js";
import type { Shop } from "../shop.js";

export interface AppConfig {
  shop: Shop;
  verify: (token: string) => Promise<Identity>;
  /** Canonical MCP endpoint URL; also the expected token audience. */
  resource: string;
  issuer: string;
  resourceMetadataUrl: string;
  /** Log request shape (JSON-RPC methods + header names, never values) to debug proxies/gateways. */
  debug?: boolean;
}

/** Tool name -> scope required to call it. Everything else is open to anonymous visitors. */
const PROTECTED_TOOLS: Record<string, string> = { one_step_checkout: CHECKOUT_SCOPE };

const MAX_BODY_BYTES = 1_000_000;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) || undefined;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requiredScopes(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((m) => {
    const msg = m as { method?: string; params?: { name?: string } };
    const scope = msg?.method === "tools/call" ? PROTECTED_TOOLS[msg.params?.name ?? ""] : undefined;
    return scope ? [scope] : [];
  });
}

export function createApp(config: AppConfig): Server {
  const { shop, verify, resource, issuer, resourceMetadataUrl } = config;

  const handleMcp = async (req: IncomingMessage, res: ServerResponse) => {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }

    if (config.debug) {
      const methods = (Array.isArray(body) ? body : [body]).map((m) => (m as { method?: string })?.method);
      console.log(`mcp request methods=${methods.join(",")} headers=${Object.keys(req.headers).sort().join(",")} session=${String(req.headers["mcp-session-id"] ?? "-")}`);
    }

    let identity: Identity | undefined;
    const token = bearerToken(req.headers.authorization);
    if (token) {
      try {
        identity = await verify(token);
      } catch (err) {
        if (!(err instanceof InvalidTokenError)) throw err;
        console.warn(`token rejected: ${err.message}`);
        return sendJson(res, 401, { error: "invalid_token" }, { "www-authenticate": wwwAuthenticate({ resourceMetadataUrl, error: "invalid_token" }) });
      }
    }

    const needed = requiredScopes(body);
    if (needed.length > 0) {
      if (!identity) {
        return sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": wwwAuthenticate({ resourceMetadataUrl, scope: needed.join(" ") }) });
      }
      const missing = needed.filter((s) => !identity.scopes.includes(s));
      if (missing.length > 0) {
        const scope = [...new Set([...identity.scopes, ...needed])].join(" ");
        return sendJson(res, 403, { error: "insufficient_scope" }, { "www-authenticate": wwwAuthenticate({ resourceMetadataUrl, scope, error: "insufficient_scope" }) });
      }
    }

    // The gateway terminates the client's Mcp-Session-Id and hands it down as x-mcp-session-id.
    // Mcp-Session-Id is only honoured as a fallback when running without a gateway.
    const sessionId = firstHeader(req, "x-mcp-session-id") ?? firstHeader(req, "mcp-session-id");

    // Stateless transport: one server + transport per request. Sessions are owned by the gateway.
    // Sessions are issued by the server (MCP spec); the gateway pairs them with the client's own session.
    const isInitialize = (Array.isArray(body) ? body : [body]).some((m) => (m as { method?: string })?.method === "initialize");
    if (isInitialize) res.setHeader("mcp-session-id", randomUUID());

    const mcp = createShopServer(shop, { sessionId, identity });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = async () => {
      if (path === "/healthz") return sendJson(res, 200, { status: "ok" });
      if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
        // Public discovery document: browser-based clients (e.g. MCP Inspector) fetch it cross-origin.
        const cors = { "access-control-allow-origin": "*" };
        if (req.method === "OPTIONS") {
          return void res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "*", "access-control-max-age": "86400" }).end();
        }
        return sendJson(res, 200, {
          resource,
          authorization_servers: [issuer],
          scopes_supported: [CHECKOUT_SCOPE],
          bearer_methods_supported: ["header"],
        }, cors);
      }
      if (path === "/mcp") {
        if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
        return handleMcp(req, res);
      }
      return sendJson(res, 404, { error: "not_found" });
    };
    route().catch((err) => {
      console.error("request failed", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    });
  });
}

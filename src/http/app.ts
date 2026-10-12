import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ApprovalWeb } from "../approval/web.js";
import { DpopError, ProofReplayCache, verifyDpopProof } from "../auth/dpop.js";
import { InvalidTokenError, parseAuthorization, type Identity } from "../auth/tokens.js";
import { wwwAuthenticate } from "../auth/challenge.js";
import { CHECKOUT_SCOPE, createShopServer, type CheckoutPolicy } from "../mcp/server.js";
import { noAudit, type AuditLog } from "../security/audit.js";
import { RateLimiter } from "../security/ratelimit.js";
import { SessionCapacityError, SessionRegistry } from "../session/registry.js";
import type { Shop } from "../domain/shop.js";

export interface AppConfig {
  shop: Shop;
  verify: (token: string) => Promise<Identity>;
  /** Canonical MCP endpoint URL; also the expected token audience. */
  resource: string;
  issuer: string;
  resourceMetadataUrl: string;
  /** Log request shape (JSON-RPC methods + header names, never values) to debug proxies/gateways. */
  debug?: boolean;

  sessions?: SessionRegistry;
  audit?: AuditLog;
  checkout?: CheckoutPolicy;
  /** Browser approval page; mounted at /approve/*. */
  approvalWeb?: ApprovalWeb;
  /**
   * Believe `x-forwarded-for`, `x-mcp-session-id` and `x-trust-tier`. Only enable when the mesh makes the gateway
   * the sole caller; otherwise any client can forge them.
   */
  trustGatewayHeaders?: boolean;
  requireDpop?: boolean;
  /** Scope added to every challenge/advertisement so clients obtain tokens that carry this server's audience. */
  apiScope?: string;
  /** Checkout needs an interactive login newer than this many seconds (0 = no check). */
  checkoutMaxAuthAgeSeconds?: number;
  /**
   * Browser origins allowed to call the MCP endpoint (MCP Streamable HTTP: servers MUST validate Origin to prevent
   * DNS rebinding). Requests without an Origin (non-browser clients) are allowed; any other Origin gets 403.
   */
  allowedOrigins?: string[];
  requestsPerMinute?: number;
  initializePerMinute?: number;
  now?: () => number;
}

/** Tool name -> scope required to call it. Everything else is open to anonymous visitors. */
const PROTECTED_TOOLS: Record<string, string> = { one_step_checkout: CHECKOUT_SCOPE, list_orders: CHECKOUT_SCOPE };

const MAX_BODY_BYTES = 1_000_000;
const SESSION_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) || undefined;
}

class BodyTooLargeError extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) throw new BodyTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const messages = (body: unknown) => (Array.isArray(body) ? body : [body]) as { method?: string; params?: { name?: string } }[];

function requiredScopes(body: unknown): string[] {
  return messages(body).flatMap((msg) => {
    const scope = msg?.method === "tools/call" ? PROTECTED_TOOLS[msg.params?.name ?? ""] : undefined;
    return scope ? [scope] : [];
  });
}

export function createApp(config: AppConfig): Server {
  const { shop, verify, resource, issuer, resourceMetadataUrl } = config;
  const audit = config.audit ?? noAudit;
  const trust = config.trustGatewayHeaders ?? false;
  const now = config.now ?? Date.now;
  const limiter = new RateLimiter(now);
  const dpopCache = new ProofReplayCache(now);
  const sessions = config.sessions ?? new SessionRegistry({ idleMs: 30 * 60_000, maxAgeMs: 24 * 3600_000, maxSessions: 10_000, maxPerSource: 200, now, newId: randomUUID });
  // Scope minimisation (MCP security best practices): advertise only what basic use needs; the checkout scope is
  // asked for by step-up challenges when a tool needs it.
  const baseScopes = config.apiScope ? [config.apiScope] : [];
  const challengeScopes = (needed: string[]) => [...new Set([...baseScopes, ...needed])].join(" ");
  const allowedOrigins = new Set(config.allowedOrigins ?? []);

  /** DNS-rebinding guard: a browser request from an origin we did not allow is refused before anything else. */
  const originRefused = (req: IncomingMessage, res: ServerResponse): boolean => {
    const origin = firstHeader(req, "origin");
    if (origin === undefined || allowedOrigins.has(origin)) return false;
    audit.record({ event: "origin_rejected", source: sourceOf(req), origin: origin.slice(0, 100) });
    sendJson(res, 403, { jsonrpc: "2.0", error: { code: -32600, message: "Origin not allowed" } });
    return true;
  };

  /** The caller's network address. Behind the gateway it is the last X-Forwarded-For hop (the one the gateway added). */
  const sourceOf = (req: IncomingMessage): string => {
    if (trust) {
      const hops = firstHeader(req, "x-forwarded-for")?.split(",").map((h) => h.trim()).filter(Boolean);
      const last = hops?.at(-1);
      if (last) return last;
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  const challenge = (res: ServerResponse, status: number, error: string, extra: Parameters<typeof wwwAuthenticate>[0]) =>
    sendJson(res, status, { error }, { "www-authenticate": wwwAuthenticate(extra) });

  const handleMcp = async (req: IncomingMessage, res: ServerResponse) => {
    if (originRefused(req, res)) return;
    const source = sourceOf(req);
    if (!limiter.allow(`req:${source}`, config.requestsPerMinute ?? 600)) {
      audit.record({ event: "rate_limited", source, scope: "requests" });
      return sendJson(res, 429, { error: "rate_limited" }, { "retry-after": "30" });
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        // Do not keep reading an attacker's stream: answer, then drop the connection.
        res.once("finish", () => req.destroy());
        return sendJson(res, 413, { error: "payload_too_large" }, { connection: "close" });
      }
      return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }

    if (config.debug) {
      const methods = messages(body).map((m) => m?.method);
      console.log(`mcp request methods=${methods.join(",")} headers=${Object.keys(req.headers).sort().join(",")}`);
    }

    // --- who is calling: token (optional for browsing), sender-constraint, step-up ---
    const needed = requiredScopes(body);
    let identity: Identity | undefined;
    const credential = parseAuthorization(req.headers.authorization);
    const dpopChallenge = { resourceMetadataUrl, dpop: true } as const;
    if (credential) {
      try {
        identity = await verify(credential.token);
      } catch (err) {
        if (!(err instanceof InvalidTokenError)) throw err;
        audit.record({ event: "token_rejected", source, reason: err.message });
        return challenge(res, 401, "invalid_token", { resourceMetadataUrl, error: "invalid_token", scope: challengeScopes(needed) });
      }
      // A token bound to a key must come with a proof from that key, presented under the DPoP scheme.
      // Accepting it as a plain Bearer would let a thief simply "downgrade" the stolen token.
      if (identity.jkt || credential.scheme === "dpop" || config.requireDpop) {
        try {
          if (!identity.jkt) throw new DpopError(credential.scheme === "dpop" ? "token is not DPoP-bound" : "this server requires DPoP-bound tokens");
          if (credential.scheme !== "dpop") throw new DpopError("DPoP-bound tokens must use the DPoP authorization scheme");
          await verifyDpopProof({ proof: firstHeader(req, "dpop"), method: req.method ?? "POST", url: resource, accessToken: credential.token, expectedJkt: identity.jkt, cache: dpopCache, now });
        } catch (err) {
          if (!(err instanceof DpopError)) throw err;
          audit.record({ event: "dpop_rejected", source, sub: identity.subject, azp: identity.clientId, reason: err.message });
          return challenge(res, 401, "invalid_dpop_proof", { ...dpopChallenge, error: "invalid_dpop_proof" });
        }
      }
    }

    if (needed.length > 0) {
      if (!identity) {
        audit.record({ event: "step_up_required", source, reason: "no_token" });
        return challenge(res, 401, "unauthorized", { resourceMetadataUrl, scope: challengeScopes(needed) });
      }
      const missing = needed.filter((s) => !identity.scopes.includes(s));
      if (missing.length > 0) {
        const scope = [...new Set([...identity.scopes, ...needed])].join(" ");
        audit.record({ event: "step_up_required", source, sub: identity.subject, azp: identity.clientId, reason: "scope" });
        return challenge(res, 403, "insufficient_scope", { resourceMetadataUrl, scope, error: "insufficient_scope" });
      }
      const maxAge = config.checkoutMaxAuthAgeSeconds ?? 0;
      if (maxAge > 0 && (identity.authTime === undefined || now() / 1000 - identity.authTime > maxAge)) {
        audit.record({ event: "step_up_required", source, sub: identity.subject, azp: identity.clientId, sid: identity.sessionId, reason: "stale_authentication" });
        return challenge(res, 401, "insufficient_user_authentication", { resourceMetadataUrl, error: "insufficient_user_authentication", maxAge });
      }
    }

    // --- which session ---
    const initializing = messages(body).some((m) => m?.method === "initialize");
    const own = firstHeader(req, "mcp-session-id");
    const forwarded = trust ? firstHeader(req, "x-mcp-session-id") : undefined;
    let sessionId: string | undefined;
    if (initializing) {
      if (!limiter.allow(`init:${source}`, config.initializePerMinute ?? 30)) {
        audit.record({ event: "rate_limited", source, scope: "initialize" });
        return sendJson(res, 429, { error: "rate_limited" }, { "retry-after": "60" });
      }
      try {
        sessionId = sessions.issue(source, identity?.subject);
      } catch (err) {
        if (!(err instanceof SessionCapacityError)) throw err;
        audit.record({ event: "session_rejected", source, reason: "capacity" });
        return sendJson(res, 503, { error: "busy" }, { "retry-after": "60" });
      }
      res.setHeader("mcp-session-id", sessionId);
      audit.record({ event: "session_created", source, session: sessionId, sub: identity?.subject, azp: identity?.clientId });
    } else if (own && sessions.check(own, identity?.subject) === "ok") {
      sessionId = own;
    } else if (own && sessions.check(own, identity?.subject) === "foreign") {
      // Bound to another customer (or used without the owner's token): answer exactly like an unknown id.
      audit.record({ event: "session_foreign", source, sub: identity?.subject });
      return sendJson(res, 404, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } });
    } else if (forwarded && SESSION_FORMAT.test(forwarded)) {
      sessionId = forwarded;
    } else if (own) {
      // Server-issued ids only: a guessed, expired or terminated id gets nothing. Clients re-initialize on 404.
      audit.record({ event: "session_unknown", source });
      return sendJson(res, 404, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } });
    }

    // Stateless transport: one server + transport per request; session state lives in the registry and shop.
    const mcp = createShopServer(shop, { sessionId, identity, source, trustTier: trust ? firstHeader(req, "x-trust-tier") : undefined }, { ...config.checkout, audit });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
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
          scopes_supported: baseScopes,
          bearer_methods_supported: ["header"],
          dpop_signing_alg_values_supported: ["ES256", "PS256"],
          dpop_bound_access_tokens_required: config.requireDpop ?? false,
        }, cors);
      }
      if (config.approvalWeb?.matches(path)) return config.approvalWeb.handle(req, res, url);
      if (path === "/mcp") {
        if (originRefused(req, res)) return;
        if (req.method === "DELETE") {
          // Client ends its session; honour it only for ids we issued.
          const own = firstHeader(req, "mcp-session-id");
          if (own) sessions.terminate(own);
          return void res.writeHead(204).end();
        }
        if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" }, { allow: "POST, DELETE" });
        return handleMcp(req, res);
      }
      return sendJson(res, 404, { error: "not_found" });
    };
    route().catch((err) => {
      console.error("request failed", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    });
  });
  // Slow-client (slowloris) limits: a request must arrive promptly; idle keep-alives are short-lived.
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

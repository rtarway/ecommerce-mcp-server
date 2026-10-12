import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { InvalidTokenError, parseAuthorization, type Identity } from "../auth/tokens.js";
import type { SessionManager } from "./engine.js";
import { handleReuseEvent, type KeycloakEvent } from "./keycloak.js";

export interface SessionManagerAppOptions {
  engine: SessionManager;
  /** Same verification the shop does: the session-manager never trusts claims it did not check itself. */
  verify: (token: string) => Promise<Identity>;
  /** Shared secret for the operator and event-ingestion endpoints. */
  adminToken: string;
  resourceMetadataUrl: string;
}

const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 100_000) throw new Error("too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/**
 * HTTP surface:
 *  - anything under /check   : gateway extAuth. 200 = allow (+ trust headers), 401/429 = deny.
 *  - POST /v1/events/keycloak: Keycloak events (webhook or the poller) -> theft playbook.
 *  - POST /v1/customers/:sub/terminate, GET /v1/customers/:sub : operator.
 */
export function createSessionManagerApp({ engine, verify, adminToken, resourceMetadataUrl }: SessionManagerAppOptions): Server {
  const isAdmin = (req: IncomingMessage) => {
    const given = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    return !!given && equal(given, adminToken);
  };

  const check = async (req: IncomingMessage, res: ServerResponse) => {
    const credential = parseAuthorization(req.headers.authorization);
    let identity: Identity | undefined;
    if (credential) {
      try {
        identity = await verify(credential.token);
      } catch (err) {
        if (!(err instanceof InvalidTokenError)) throw err;
        // The shop answers invalid tokens itself with the proper challenge; do not duplicate that logic here.
        return send(res, 200, { ok: true }, { "x-trust-tier": "anonymous" });
      }
    }
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    const source = xff[xff.length - 1] ?? req.socket.remoteAddress ?? "unknown";
    const decision = engine.evaluate({ identity, source, userAgent: String(req.headers["user-agent"] ?? "") || undefined });
    if (decision.action === "deny") {
      const challenge: Record<string, string> = decision.status === 401 ? { "www-authenticate": `Bearer error="invalid_token", error_description="${decision.description}", resource_metadata="${resourceMetadataUrl}"` } : { "retry-after": "60" };
      return send(res, decision.status, { error: decision.error, error_description: decision.description }, challenge);
    }
    send(res, 200, { ok: true }, { "x-trust-tier": decision.tier, ...(decision.installationId ? { "x-installation-id": decision.installationId } : {}) });
  };

  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const route = async () => {
      if (path === "/healthz") return send(res, 200, { status: "ok" });
      if (path === "/check" || path.startsWith("/check/")) return check(req, res);
      if (!path.startsWith("/v1/")) return send(res, 404, { error: "not_found" });
      if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
      if (req.method === "POST" && path === "/v1/events/keycloak") {
        const events = [await readJson(req)].flat() as KeycloakEvent[];
        let acted = 0;
        for (const e of events) {
          if (await handleReuseEvent(engine, e)) acted++;
        }
        return send(res, 202, { received: events.length, acted });
      }
      const m = /^\/v1\/customers\/([^/]+)(\/terminate)?$/.exec(path);
      if (m) {
        const sub = decodeURIComponent(m[1]!);
        if (req.method === "POST" && m[2]) {
          await engine.terminateCustomer(sub, "operator_request");
          return send(res, 202, { terminated: sub });
        }
        if (req.method === "GET" && !m[2]) {
          const snap = engine.snapshot(sub);
          return snap ? send(res, 200, snap) : send(res, 404, { error: "unknown_customer" });
        }
      }
      return send(res, 404, { error: "not_found" });
    };
    route().catch((err) => {
      console.error("session-manager request failed", err instanceof Error ? err.message : err);
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
    });
  });
}

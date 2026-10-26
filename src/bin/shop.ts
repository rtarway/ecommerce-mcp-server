/** Shop MCP server process: wires configuration, identity provider keys, shop services and the HTTP app. */
import { randomUUID } from "node:crypto";
import { createRemoteJWKSet } from "jose";
import { placeApprovedOrder } from "../approval/complete.js";
import { ApprovalService } from "../approval/service.js";
import { OidcLogin } from "../approval/oidc.js";
import { ApprovalWeb } from "../approval/web.js";
import { createTokenVerifier } from "../auth/tokens.js";
import { loadConfig } from "../config/shop.js";
import { createApp } from "../http/app.js";
import { stdoutAudit, noAudit } from "../security/audit.js";
import { SessionRegistry } from "../session/registry.js";
import { buildShop } from "../domain/shop.js";

const config = loadConfig(process.env);
const audit = config.AUDIT_LOG ? stdoutAudit : noAudit;
const keySet = createRemoteJWKSet(new URL(config.JWKS_URL));

const shop = buildShop({
  profileSubjects: config.DEMO_PROFILE_SUBJECTS,
  cartLimits: { anonymousIdleMs: config.ANON_CART_IDLE_SECONDS * 1000, customerIdleMs: config.CUSTOMER_CART_IDLE_SECONDS * 1000, maxCarts: config.MAX_CARTS },
  spendLimits: { maxOrderCents: config.MAX_ORDER_CENTS, dailyCapCents: config.DAILY_SPEND_CAP_CENTS },
  mandate: { amountCents: config.DEMO_MANDATE_CENTS, windowMs: config.MANDATE_WINDOW_HOURS * 3600_000 },
});
const sessions = new SessionRegistry({
  idleMs: config.SESSION_IDLE_SECONDS * 1000,
  maxAgeMs: config.SESSION_MAX_SECONDS * 1000,
  maxSessions: config.MAX_SESSIONS,
  maxPerSource: config.MAX_SESSIONS_PER_SOURCE,
  newId: randomUUID,
});

let checkout = {};
let approvalWeb: ApprovalWeb | undefined;
if (config.REQUIRE_APPROVAL) {
  if (!config.APPROVAL_CLIENT_SECRET || !config.PUBLIC_BASE_URL) throw new Error("REQUIRE_APPROVAL=true needs APPROVAL_CLIENT_SECRET and PUBLIC_BASE_URL");
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, "");
  const approvals = new ApprovalService({ ttlMs: config.APPROVAL_TTL_SECONDS * 1000 });
  const login = new OidcLogin({
    issuer: config.ISSUER,
    tokenEndpoint: config.TOKEN_URL ?? config.JWKS_URL.replace(/\/certs$/, "/token"),
    clientId: config.APPROVAL_CLIENT_ID,
    clientSecret: config.APPROVAL_CLIENT_SECRET,
    keySet,
  });
  approvalWeb = new ApprovalWeb({
    approvals,
    login,
    audit,
    publicBaseUrl: base,
    placeOrder: (approval) => {
      const { order } = placeApprovedOrder(shop, approvals, approval);
      return { orderId: order.orderId, totalCents: order.totalCents };
    },
  });
  checkout = { approvals, approvalUrl: (id: string) => `${base}/approve/${id}` };
} else {
  console.warn("REQUIRE_APPROVAL=false: a scoped token alone can place orders. Development only.");
}

const app = createApp({
  shop,
  verify: createTokenVerifier({ issuer: config.ISSUER, audience: config.RESOURCE_URL, keySet }),
  resource: config.RESOURCE_URL,
  issuer: config.ISSUER,
  resourceMetadataUrl: config.resourceMetadataUrl,
  debug: config.DEBUG_REQUESTS,
  sessions,
  audit,
  checkout,
  approvalWeb,
  trustGatewayHeaders: config.TRUST_GATEWAY_HEADERS,
  requireDpop: config.REQUIRE_DPOP,
  apiScope: config.API_SCOPE || undefined,
  requireSignIn: config.REQUIRE_SIGN_IN,
  checkoutMaxAuthAgeSeconds: config.CHECKOUT_MAX_AUTH_AGE_SECONDS,
  allowedOrigins: config.ALLOWED_ORIGINS,
  requestsPerMinute: config.REQUESTS_PER_MINUTE_PER_SOURCE,
  initializePerMinute: config.INITIALIZE_PER_MINUTE_PER_SOURCE,
});

app.listen(config.PORT, () => console.log(`ecommerce-mcp-server listening on :${config.PORT}`));
setInterval(() => sessions.sweep(), 60_000).unref();
process.on("SIGTERM", () => app.close(() => process.exit(0)));

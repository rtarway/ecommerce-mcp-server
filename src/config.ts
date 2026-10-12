import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  /** Token issuer (Keycloak realm URL), exactly as it appears in the `iss` claim. */
  ISSUER: z.url(),
  /** Where to fetch signing keys; may differ from ISSUER (in-cluster service address). */
  JWKS_URL: z.url(),
  /** Public MCP endpoint URL on the gateway; the expected `aud` of access tokens. */
  RESOURCE_URL: z.url(),
  DEBUG_REQUESTS: z.stringbool().default(false),

  /**
   * Trust `x-forwarded-for` / `x-mcp-session-id` from the network. Only safe when the mesh guarantees
   * that nothing except the gateway can reach this server (STRICT mTLS + AuthorizationPolicy).
   */
  TRUST_GATEWAY_HEADERS: z.stringbool().default(false),
  /** Require DPoP-bound access tokens (RFC 9449). Tokens that carry `cnf.jkt` are always sender-checked. */
  REQUIRE_DPOP: z.stringbool().default(false),
  /** Browser origins allowed to call /mcp (comma-separated). Requests without Origin are allowed; others get 403. */
  ALLOWED_ORIGINS: csv,
  /** Resource scope (carries the audience mapper in Keycloak) added to every challenge and to the advertised scopes. Empty = none. */
  API_SCOPE: z.string().default(""),

  // --- sessions, carts, rate limits (all bounded: H1/H2) ---
  SESSION_IDLE_SECONDS: z.coerce.number().int().positive().default(30 * 60),
  SESSION_MAX_SECONDS: z.coerce.number().int().positive().default(24 * 3600),
  MAX_SESSIONS: z.coerce.number().int().positive().default(10_000),
  MAX_SESSIONS_PER_SOURCE: z.coerce.number().int().positive().default(200),
  ANON_CART_IDLE_SECONDS: z.coerce.number().int().positive().default(2 * 3600),
  CUSTOMER_CART_IDLE_SECONDS: z.coerce.number().int().positive().default(24 * 3600),
  MAX_CARTS: z.coerce.number().int().positive().default(50_000),
  REQUESTS_PER_MINUTE_PER_SOURCE: z.coerce.number().int().positive().default(600),
  INITIALIZE_PER_MINUTE_PER_SOURCE: z.coerce.number().int().positive().default(30),

  // --- checkout guard (H6/M6/M7) ---
  /** 0 disables the token-age check; the human approval below is the real proof of presence. */
  CHECKOUT_MAX_AUTH_AGE_SECONDS: z.coerce.number().int().min(0).default(0),
  REQUIRE_APPROVAL: z.stringbool().default(true),
  APPROVAL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  MAX_ORDER_CENTS: z.coerce.number().int().positive().default(50_000),
  DAILY_SPEND_CAP_CENTS: z.coerce.number().int().positive().default(100_000),

  // --- approval page: the server is itself an OIDC client so only the human can approve ---
  /** Browser-visible base URL of this shop (the gateway), e.g. http://localhost:8000 */
  PUBLIC_BASE_URL: z.url().optional(),
  APPROVAL_CLIENT_ID: z.string().default("shop-approval"),
  APPROVAL_CLIENT_SECRET: z.string().optional(),
  /** In-cluster token endpoint; defaults to ISSUER-based URL. */
  TOKEN_URL: z.url().optional(),

  /**
   * Spending mandate on the demo customers' accounts: what agents may spend per window without asking. 0 = every
   * purchase needs the customer's approval. Shared by all of the customer's clients and devices.
   */
  DEMO_MANDATE_CENTS: z.coerce.number().int().min(0).default(0),
  MANDATE_WINDOW_HOURS: z.coerce.number().positive().default(24),

  /** Keycloak user ids (`sub`) that have a saved profile in this demo. */
  DEMO_PROFILE_SUBJECTS: csv,
  AUDIT_LOG: z.stringbool().default(true),
});

export type Config = z.infer<typeof schema> & { resourceMetadataUrl: string };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.parse(env);
  if (parsed.REQUIRE_APPROVAL && !parsed.PUBLIC_BASE_URL) {
    // Fail closed: money must not move without approval unless someone explicitly turned it off.
    throw new Error("REQUIRE_APPROVAL=true needs PUBLIC_BASE_URL (and APPROVAL_CLIENT_SECRET); set REQUIRE_APPROVAL=false only for local dev");
  }
  const { origin, pathname } = new URL(parsed.RESOURCE_URL);
  const path = pathname === "/" ? "" : pathname.replace(/\/$/, "");
  return { ...parsed, resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource${path}` };
}

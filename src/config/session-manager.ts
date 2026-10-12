import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().default(3100),
  /** Token issuer (Keycloak realm URL), exactly as it appears in the `iss` claim. */
  ISSUER: z.url(),
  JWKS_URL: z.url(),
  /** The shop's resource URL: tokens are verified with it as audience, as the shop does. */
  RESOURCE_URL: z.url(),
  /** Keycloak base URL for the admin API (in-cluster address). */
  KEYCLOAK_URL: z.url(),
  KEYCLOAK_REALM: z.string().default("mcp"),
  SM_CLIENT_ID: z.string().default("session-manager"),
  SM_CLIENT_SECRET: z.string().min(16),
  /** Shared secret for the operator and event-ingestion endpoints. */
  ADMIN_TOKEN: z.string().min(24),
  /** New installations of an existing customer cannot check out for this long. 0 = off. */
  COOLING_OFF_SECONDS: z.coerce.number().int().min(0).default(0),
  /** After a theft response, new sign-ins of that customer are cooling-off for this long. */
  INCIDENT_WINDOW_SECONDS: z.coerce.number().int().min(0).default(900),
  /** Same token family from two unrelated networks within this window = theft. */
  DISJOINT_NETWORK_WINDOW_SECONDS: z.coerce.number().int().positive().default(120),
  MAX_NEW_INSTALLATIONS_PER_HOUR: z.coerce.number().int().positive().default(10),
  /** How often to poll Keycloak for refresh-token reuse events. 0 = off. */
  EVENT_POLL_SECONDS: z.coerce.number().int().min(0).default(10),
});

export type SessionManagerConfig = z.infer<typeof schema> & { resourceMetadataUrl: string };

export function loadSessionManagerConfig(env: Record<string, string | undefined>): SessionManagerConfig {
  const parsed = schema.parse(env);
  const { origin, pathname } = new URL(parsed.RESOURCE_URL);
  return { ...parsed, resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource${pathname}` };
}

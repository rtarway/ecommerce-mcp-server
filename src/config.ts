import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  /** Token issuer (Keycloak realm URL), exactly as it appears in the `iss` claim. */
  ISSUER: z.url(),
  /** Where to fetch signing keys; may differ from ISSUER (in-cluster service address). */
  JWKS_URL: z.url(),
  /** Public MCP endpoint URL on the gateway; the expected `aud` of access tokens. */
  RESOURCE_URL: z.url(),
});

export type Config = z.infer<typeof schema> & { resourceMetadataUrl: string };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.parse(env);
  const { origin, pathname } = new URL(parsed.RESOURCE_URL);
  const path = pathname === "/" ? "" : pathname.replace(/\/$/, "");
  return { ...parsed, resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource${path}` };
}

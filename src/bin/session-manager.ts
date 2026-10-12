/** Session-manager process: gateway extAuth, theft detection and response. Wires config to components. */
import { createRemoteJWKSet } from "jose";
import { createTokenVerifier } from "../auth/tokens.js";
import { loadSessionManagerConfig } from "../config/session-manager.js";
import { stdoutAudit } from "../security/audit.js";
import { createSessionManagerApp } from "../session-manager/app.js";
import { SessionManager } from "../session-manager/engine.js";
import { KeycloakAdminClient, handleReuseEvent } from "../session-manager/keycloak.js";

const env = loadSessionManagerConfig(process.env);

const admin = new KeycloakAdminClient({ baseUrl: env.KEYCLOAK_URL, realm: env.KEYCLOAK_REALM, clientId: env.SM_CLIENT_ID, clientSecret: env.SM_CLIENT_SECRET });
const engine = new SessionManager({
  admin,
  audit: stdoutAudit,
  // Stand-in for email/push; a real deployment sends the customer a message here.
  notifier: { notify: (sub, kind, detail) => console.log(JSON.stringify({ notify: true, ts: new Date().toISOString(), sub, kind, ...detail })) },
  coolingOffMs: env.COOLING_OFF_SECONDS * 1000,
  incidentWindowMs: env.INCIDENT_WINDOW_SECONDS * 1000,
  maxNewInstallationsPerHour: env.MAX_NEW_INSTALLATIONS_PER_HOUR,
  disjointNetworkWindowMs: env.DISJOINT_NETWORK_WINDOW_SECONDS * 1000,
});

const app = createSessionManagerApp({
  engine,
  verify: createTokenVerifier({ issuer: env.ISSUER, audience: env.RESOURCE_URL, keySet: createRemoteJWKSet(new URL(env.JWKS_URL)) }),
  adminToken: env.ADMIN_TOKEN,
  resourceMetadataUrl: env.resourceMetadataUrl,
});
app.listen(env.PORT, () => console.log(`session-manager listening on :${env.PORT}`));

// Keycloak has no built-in webhook, so poll its admin events for refresh-token reuse (rotation violation).
if (env.EVENT_POLL_SECONDS > 0) {
  let since = Date.now();
  setInterval(async () => {
    const from = since;
    since = Date.now();
    try {
      for (const e of await admin.recentEvents("REFRESH_TOKEN_ERROR", from)) {
        await handleReuseEvent(engine, e);
      }
    } catch (err) {
      since = from; // retry the same window next time
      console.error("event poll failed", err instanceof Error ? err.message : err);
    }
  }, env.EVENT_POLL_SECONDS * 1000).unref();
}
process.on("SIGTERM", () => app.close(() => process.exit(0)));

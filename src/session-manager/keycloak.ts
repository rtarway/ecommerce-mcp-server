import type { KeycloakAdmin } from "./engine.js";

export interface KeycloakAdminOptions {
  /** Base URL, e.g. http://keycloak-service.keycloak.svc.cluster.local:8080 */
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
}

export interface KeycloakEvent {
  time: number;
  type: string;
  userId?: string;
  /** Keycloak session id; equals the `sid` claim of tokens minted in that session. */
  sessionId?: string;
  clientId?: string;
  error?: string;
  details?: Record<string, string>;
}

/** Minimal Keycloak admin client: a service account with only the roles it needs (manage-users, manage-events, view-events). */
export class KeycloakAdminClient implements KeycloakAdmin {
  private token?: { value: string; expires: number };

  constructor(private readonly o: KeycloakAdminOptions) {}

  async logoutUser(sub: string) {
    await this.call("POST", `/users/${encodeURIComponent(sub)}/logout`);
  }

  async revokeConsent(sub: string, clientId: string) {
    await this.call("DELETE", `/users/${encodeURIComponent(sub)}/consents/${encodeURIComponent(clientId)}`, [204, 404]);
  }

  async recentEvents(type: string, sinceMs: number): Promise<KeycloakEvent[]> {
    const day = new Date(sinceMs).toISOString().slice(0, 10);
    const res = await this.call("GET", `/events?type=${encodeURIComponent(type)}&dateFrom=${day}&max=200`);
    return ((await res.json()) as KeycloakEvent[]).filter((e) => e.time >= sinceMs);
  }

  private async call(method: string, path: string, okStatuses: number[] = [200, 204]) {
    const res = await fetch(`${this.o.baseUrl}/admin/realms/${this.o.realm}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!okStatuses.includes(res.status)) throw new Error(`keycloak ${method} ${path.split("?")[0]} -> ${res.status}`);
    return res;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 10_000) return this.token.value;
    const res = await fetch(`${this.o.baseUrl}/realms/${this.o.realm}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.o.clientId, client_secret: this.o.clientSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`keycloak token endpoint answered ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }
}

/** True when a Keycloak event says a rotated refresh token was presented again: someone holds a stale copy. */
export function isRefreshTokenReuse(e: KeycloakEvent): boolean {
  if (e.type !== "REFRESH_TOKEN_ERROR" || (!e.userId && !e.sessionId)) return false;
  const text = [e.error, ...Object.values(e.details ?? {})].join(" ").toLowerCase();
  return /reuse/.test(text);
}

/** Runs the theft playbook for one reuse event, whether it names the user or only the session. */
export async function handleReuseEvent(
  engine: { terminateCustomer(sub: string, r: "refresh_token_reuse", d?: Record<string, unknown>): Promise<void>; terminateBySession(sid: string, r: "refresh_token_reuse", d?: Record<string, unknown>): Promise<boolean> },
  e: KeycloakEvent,
): Promise<boolean> {
  if (!isRefreshTokenReuse(e)) return false;
  if (e.userId) {
    await engine.terminateCustomer(e.userId, "refresh_token_reuse", { azp: e.clientId, sid: e.sessionId });
    return true;
  }
  if (!e.sessionId) return false;
  return engine.terminateBySession(e.sessionId, "refresh_token_reuse", { azp: e.clientId });
}

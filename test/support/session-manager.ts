/** Test doubles for the session-manager: a customer identity builder, two networks, a fake Keycloak admin, a notifier. */
import type { Identity } from "../../src/auth/tokens.js";
import type { KeycloakAdmin, Notifier } from "../../src/session-manager/engine.js";

export const id = (over: Partial<Identity> = {}): Identity => ({ subject: "cust-1", username: "u", clientId: "agent-a", scopes: [], sessionId: "sid-1", tokenId: "jti-1", ...over });
export const HOME = "203.0.113.7";
export const ELSEWHERE = "198.51.100.9";

export class FakeAdmin implements KeycloakAdmin {
  calls: string[] = [];
  fail = false;
  async logoutUser(sub: string) {
    if (this.fail) throw new Error("keycloak down");
    this.calls.push(`logout:${sub}`);
  }
  async revokeConsent(sub: string, clientId: string) {
    this.calls.push(`revoke:${sub}:${clientId}`);
  }
}
export class Notes implements Notifier {
  sent: string[] = [];
  notify(sub: string, kind: string) {
    this.sent.push(`${sub}:${kind}`);
  }
}

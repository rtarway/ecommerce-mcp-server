/**
 * Structured audit trail (H7). One JSON object per line on stdout; never contains tokens or card data.
 * The session-manager and any SIEM consume the same shape.
 */
export type AuditEvent =
  | "session_created"
  | "session_rejected"
  | "session_unknown"
  | "session_foreign"
  | "origin_rejected"
  | "rate_limited"
  | "token_rejected"
  | "dpop_rejected"
  | "step_up_required"
  | "sign_in_required"
  | "cart_claimed"
  | "approval_requested"
  | "approval_granted"
  | "approval_denied"
  | "approval_wrong_user"
  | "approval_expired"
  | "checkout_attempted"
  | "checkout_blocked"
  | "order_placed"
  | "order_replayed"
  | "spend_limit_hit"
  /** A signed-in agent searched or changed the cart: the customer's agent browsing behaviour (report R5). */
  | "browse";

export interface AuditRecord {
  event: AuditEvent;
  /** Customer id (`sub`), when known. */
  sub?: string;
  /** OAuth client (`azp`). */
  azp?: string;
  /** Keycloak session id (`sid`) shared by all tokens of one refresh chain. */
  sid?: string;
  jti?: string;
  session?: string;
  source?: string;
  [detail: string]: unknown;
}

export interface AuditLog {
  record(rec: AuditRecord): void;
}

export const stdoutAudit: AuditLog = {
  record: (rec) => console.log(JSON.stringify({ audit: true, ts: new Date().toISOString(), ...rec })),
};

export const noAudit: AuditLog = { record: () => {} };

export class MemoryAudit implements AuditLog {
  readonly records: AuditRecord[] = [];
  record(rec: AuditRecord) {
    this.records.push(rec);
  }
  events() {
    return this.records.map((r) => r.event);
  }
}

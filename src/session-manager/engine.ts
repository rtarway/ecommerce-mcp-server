import type { Identity } from "../auth/tokens.js";
import type { AuditLog } from "../security/audit.js";
import { deleteOldest } from "../shared/collections.js";

/**
 * Decides, per request, whether a token belongs to a believable installation, and runs the "root out the thief"
 * playbook when a high-confidence theft signal fires. It never needs to know *which* session is the thief's:
 * it resets everything and only someone who can log in again (password + MFA) gets back in.
 *
 * An *installation* is one authorization grant: (sub, azp, sid). `sid` is Keycloak's session id, shared by every
 * access token minted from one refresh-token chain, so it is the stable handle (client_id alone is not: under CIMD
 * every install of an app shares it).
 */

export interface KeycloakAdmin {
  /** Ends every online session of the user. */
  logoutUser(sub: string): Promise<void>;
  /** Revokes the user's consent for a client (also invalidates its offline tokens). */
  revokeConsent(sub: string, clientId: string): Promise<void>;
}

export interface Notifier {
  notify(sub: string, kind: string, detail?: Record<string, unknown>): void;
}

export interface EngineOptions {
  admin: KeycloakAdmin;
  notifier: Notifier;
  audit: AuditLog;
  now?: () => number;
  /** A newly linked installation of an existing customer cannot check out for this long. 0 = off. */
  coolingOffMs?: number;
  /** After a theft response, *every* new installation of that customer is cooling-off for this long. */
  incidentWindowMs?: number;
  /** Same token family seen from two unrelated networks within this window = theft. */
  disjointNetworkWindowMs?: number;
  /** New installations per customer per hour before we slow down. */
  maxNewInstallationsPerHour?: number;
  /** Cap on automatic terminations per customer per hour, so the response cannot be used as a lockout machine. */
  maxTerminationsPerHour?: number;
  maxCustomers?: number;
}

export interface CheckRequest {
  identity?: Identity;
  source: string;
  userAgent?: string;
}

export type Tier = "anonymous" | "normal" | "cooling_off";

export type Decision =
  | { action: "allow"; tier: Tier; installationId?: string }
  | { action: "deny"; status: 401 | 429; error: "invalid_token" | "rate_limited"; description: string };

export type TheftReason = "refresh_token_reuse" | "token_family_on_disjoint_networks" | "operator_request";

interface Installation {
  id: string;
  azp: string;
  sid: string;
  firstSeen: number;
  lastSeen: number;
  recent: { net: string; at: number }[];
  userAgents: Set<string>;
  terminated: boolean;
  /** Checkout is held back (tier cooling_off) until this time. */
  coolOffUntil: number;
}

interface Customer {
  installations: Map<string, Installation>;
  deniedSids: Map<string, number>;
  newInstallationTimes: number[];
  terminations: number[];
  elevatedUntil: number;
}

const HOUR = 3600_000;
const MAX_INSTALLATIONS_PER_CUSTOMER = 50;
const MAX_RECENT_NETWORKS = 8;
const DENIED_SID_TTL = HOUR;
const ENDED = "this sign-in was ended for your protection; please sign in again";

/** Coarse network identity: IPv4 /24, IPv6 /48. Phones roaming inside a carrier range should not look like theft. */
export function networkOf(source: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(source);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (source.includes(":")) return `${source.split(":").slice(0, 3).join(":")}::/48`;
  return source;
}

export class SessionManager {
  private readonly customers = new Map<string, Customer>();
  private readonly now: () => number;
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly o: EngineOptions) {
    this.now = o.now ?? Date.now;
  }

  evaluate({ identity, source, userAgent }: CheckRequest): Decision {
    if (!identity) return { action: "allow", tier: "anonymous" };
    const t = this.now();
    const customer = this.customer(identity.subject);
    const sid = identity.sessionId ?? `jti:${identity.tokenId ?? "unknown"}`;
    const azp = identity.clientId ?? "unknown";
    const id = `${azp}|${sid}`;
    const windowMs = this.o.disjointNetworkWindowMs ?? 120_000;

    if (customer.deniedSids.has(sid) || customer.installations.get(id)?.terminated) {
      return { action: "deny", status: 401, error: "invalid_token", description: ENDED };
    }

    let inst = customer.installations.get(id);
    const net = networkOf(source);

    if (!inst) {
      customer.newInstallationTimes = customer.newInstallationTimes.filter((x) => t - x < HOUR);
      if (customer.newInstallationTimes.length >= (this.o.maxNewInstallationsPerHour ?? 10)) {
        this.o.audit.record({ event: "rate_limited", sub: identity.subject, scope: "new_installations" });
        return { action: "deny", status: 429, error: "rate_limited", description: "too many new apps linked recently" };
      }
      customer.newInstallationTimes.push(t);
      inst = { id, azp, sid, firstSeen: t, lastSeen: t, recent: [], userAgents: new Set(), terminated: false, coolOffUntil: 0 };
      this.admitInstallation(customer, inst);
      const existing = customer.installations.size > 1;
      if (existing) this.o.notifier.notify(identity.subject, "new_installation", { azp, userAgent });
      const coolingOff = existing ? (this.o.coolingOffMs ?? 0) : 0;
      const incident = t < customer.elevatedUntil ? customer.elevatedUntil - t : 0;
      inst.coolOffUntil = t + Math.max(coolingOff, incident);
    } else {
      const clash = inst.recent.find((r) => t - r.at <= windowMs && r.net !== net);
      if (clash) {
        this.track(this.terminateCustomer(identity.subject, "token_family_on_disjoint_networks", { azp, networks: [clash.net, net] }));
        return { action: "deny", status: 401, error: "invalid_token", description: ENDED };
      }
    }

    inst.lastSeen = t;
    inst.recent = [...inst.recent.filter((r) => t - r.at <= windowMs && r.net !== net), { net, at: t }].slice(-MAX_RECENT_NETWORKS);
    if (userAgent && inst.userAgents.size < 8) inst.userAgents.add(userAgent.slice(0, 120));

    const tier: Tier = t < inst.coolOffUntil ? "cooling_off" : "normal";
    return { action: "allow", tier, installationId: id };
  }

  /**
   * The playbook for a high-confidence theft signal: end the customer's sessions at the identity provider, revoke
   * consent for the affected apps, refuse every token of the affected families here, and put the customer in a
   * heightened state so whatever logs in next is cooling-off. Idempotent and rate limited.
   */
  async terminateCustomer(sub: string, reason: TheftReason, detail: Record<string, unknown> = {}): Promise<void> {
    const t = this.now();
    const c = this.customer(sub);
    const azps = new Set<string>();
    for (const inst of c.installations.values()) {
      inst.terminated = true;
      c.deniedSids.set(inst.sid, t + DENIED_SID_TTL);
      azps.add(inst.azp);
    }
    const sid = detail.sid;
    if (typeof sid === "string") c.deniedSids.set(sid, t + DENIED_SID_TTL);
    c.elevatedUntil = t + (this.o.incidentWindowMs ?? 15 * 60_000);

    c.terminations = c.terminations.filter((x) => t - x < HOUR);
    const budget = this.o.maxTerminationsPerHour ?? 3;
    this.o.audit.record({ event: "session_rejected", sub, reason, ...detail, remote: c.terminations.length < budget });
    if (c.terminations.length >= budget) return; // local denial stays; stop hammering Keycloak
    c.terminations.push(t);

    this.o.notifier.notify(sub, "sessions_terminated", { reason });
    const clients = typeof detail.azp === "string" ? new Set([...azps, detail.azp]) : azps;
    try {
      await this.o.admin.logoutUser(sub);
      for (const azp of clients) if (azp !== "unknown") await this.o.admin.revokeConsent(sub, azp);
    } catch (err) {
      console.error("keycloak invalidation failed (local denial remains in force)", err instanceof Error ? err.message : err);
    }
  }

  /**
   * Keycloak events name the session (`sid`), not always the user. Resolve the customer from the installations we
   * have seen; an unknown session means we never saw its tokens, so there is nothing of ours to cut.
   */
  async terminateBySession(sid: string, reason: TheftReason, detail: Record<string, unknown> = {}): Promise<boolean> {
    for (const [sub, c] of this.customers) {
      if ([...c.installations.values()].some((i) => i.sid === sid)) {
        await this.terminateCustomer(sub, reason, { ...detail, sid });
        return true;
      }
    }
    return false;
  }

  /** Resolves when background invalidations (calls to Keycloak) have finished. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private track(p: Promise<void>) {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /** What the operator and the demo can inspect. Never includes tokens. */
  snapshot(sub: string) {
    const c = this.customers.get(sub);
    if (!c) return undefined;
    return {
      elevated: this.now() < c.elevatedUntil,
      installations: [...c.installations.values()].map((i) => ({ id: i.id, azp: i.azp, firstSeen: i.firstSeen, lastSeen: i.lastSeen, networks: i.recent.map((r) => r.net), terminated: i.terminated })),
      deniedSessions: c.deniedSids.size,
    };
  }

  private admitInstallation(c: Customer, inst: Installation) {
    if (c.installations.size >= MAX_INSTALLATIONS_PER_CUSTOMER) {
      const oldest = [...c.installations.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest) c.installations.delete(oldest.id);
    }
    c.installations.set(inst.id, inst);
  }

  private customer(sub: string): Customer {
    let c = this.customers.get(sub);
    if (!c) {
      if (this.customers.size >= (this.o.maxCustomers ?? 100_000)) deleteOldest(this.customers);
      c = { installations: new Map(), deniedSids: new Map(), newInstallationTimes: [], terminations: [], elevatedUntil: 0 };
      this.customers.set(sub, c);
    }
    const t = this.now();
    for (const [sid, until] of c.deniedSids) if (until <= t) c.deniedSids.delete(sid);
    return c;
  }
}

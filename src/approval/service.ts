import { randomBytes } from "node:crypto";
import type { Address, PaymentMethod } from "../domain/checkout.js";

export interface ApprovalSummary {
  items: { productId: string; name: string; quantity: number; unitPriceCents: number }[];
  totalCents: number;
  payment: PaymentMethod;
  shippingAddress: Address;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "consumed";

export interface Approval {
  id: string;
  subject: string;
  clientId: string | undefined;
  cartHash: string;
  summary: ApprovalSummary;
  status: ApprovalStatus;
  expiresAt: number;
  orderId?: string;
}

export class ApprovalCapacityError extends Error {}

export interface ApprovalOptions {
  ttlMs: number;
  maxLive?: number;
  maxLivePerSubject?: number;
  now?: () => number;
  newId?: () => string;
}

/**
 * A purchase approval is a one-time capability that only the signed-in customer can grant, on a page this
 * server renders (amount, items, card, address). The agent only ever sees the id, which grants nothing.
 */
export class ApprovalService {
  private readonly approvals = new Map<string, Approval>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly maxLive: number;
  private readonly maxPerSubject: number;

  constructor(private readonly opts: ApprovalOptions) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => randomBytes(32).toString("base64url"));
    this.maxLive = opts.maxLive ?? 10_000;
    this.maxPerSubject = opts.maxLivePerSubject ?? 5;
  }

  /** The live approval for exactly this cart, or a fresh one. Repeated agent calls do not spawn new requests. */
  request(subject: string, clientId: string | undefined, cartHash: string, summary: ApprovalSummary): Approval {
    this.sweep();
    for (const a of this.approvals.values()) {
      if (a.subject === subject && a.cartHash === cartHash && a.status !== "consumed") return a;
    }
    // A thief spamming checkouts must not be able to crowd out the customer's own request: drop the oldest instead.
    const mine = [...this.approvals.values()].filter((a) => a.subject === subject && a.status === "pending");
    if (mine.length >= this.maxPerSubject) this.approvals.delete(mine[0]!.id);
    if (this.approvals.size >= this.maxLive) throw new ApprovalCapacityError("The shop is busy; please try again shortly");
    const approval: Approval = { id: this.newId(), subject, clientId, cartHash, summary, status: "pending", expiresAt: this.now() + this.opts.ttlMs };
    this.approvals.set(approval.id, approval);
    return approval;
  }

  get(id: string): Approval | undefined {
    const a = this.approvals.get(id);
    if (a && a.expiresAt <= this.now() && a.status !== "consumed") {
      this.approvals.delete(id);
      return undefined;
    }
    return a;
  }

  /** Records the customer's decision. Only the customer the approval was issued to can decide. */
  decide(id: string, subject: string, approve: boolean): "ok" | "wrong_user" | "gone" {
    const a = this.get(id);
    if (!a || a.status !== "pending") return "gone";
    if (a.subject !== subject) return "wrong_user";
    a.status = approve ? "approved" : "denied";
    return "ok";
  }

  /** Forgets a request (e.g. a decline the agent has now been told about), so a deliberate retry gets a fresh one. */
  dismiss(id: string) {
    this.approvals.delete(id);
  }

  /** The customer's most recently completed approval that is still remembered (for answering retried checkouts). */
  recentlyConsumed(subject: string): Approval | undefined {
    this.sweep();
    return [...this.approvals.values()].reverse().find((a) => a.subject === subject && a.status === "consumed");
  }

  consume(id: string, orderId: string) {
    const a = this.approvals.get(id);
    if (a) {
      a.status = "consumed";
      a.orderId = orderId;
      a.expiresAt = this.now() + this.opts.ttlMs; // keep briefly so a retried call is answered idempotently
    }
  }

  private sweep() {
    const t = this.now();
    for (const [id, a] of this.approvals) if (a.expiresAt <= t) this.approvals.delete(id);
  }
}

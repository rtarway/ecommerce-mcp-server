import { createHash, randomBytes } from "node:crypto";
import type { Cart, CartService } from "./cart.js";

export interface Address {
  name: string;
  line1: string;
  city: string;
  postalCode: string;
  country: string;
}

/** Only the non-sensitive parts of a saved card; the real card never lives in this service. */
export interface PaymentMethod {
  brand: string;
  last4: string;
}

/**
 * What the customer lets agents spend WITHOUT asking each time: a budget per rolling window, on the customer's account
 * (not per client or device). Every installation of the customer draws on the same remaining budget; anything that
 * does not fit needs the customer's approval. 0 = every purchase needs approval. Set by the shop (the customer, on the
 * website); never through an MCP tool, so an agent cannot raise its own allowance.
 */
export interface SpendingMandate {
  amountCents: number;
  windowMs: number;
}

export interface CustomerProfile {
  shippingAddress: Address;
  payment: PaymentMethod;
  mandate?: SpendingMandate;
}

/** How a purchase was authorised. Only `spending_mandate` purchases count against the mandate. */
export type Authorization = "customer_approval" | "spending_mandate" | "direct";

export interface MandateStatus {
  amountCents: number;
  windowMs: number;
  usedCents: number;
  remainingCents: number;
}

/** Profiles are keyed by the immutable token subject, never by a mutable username (H4). */
export interface ProfileRepository {
  find(subject: string): CustomerProfile | undefined;
}

export interface Order extends Cart {
  orderId: string;
  /** Customer (`sub`) the order was placed for. */
  subject: string;
  createdAt: number;
  authorizedBy: Authorization;
  shippingAddress: Address;
  payment: PaymentMethod;
}

export class EmptyCartError extends Error {
  constructor() {
    super("Your cart is empty");
  }
}

export class NoProfileError extends Error {
  constructor() {
    super("No saved shipping address / payment method on this account");
  }
}

export class SpendLimitError extends Error {}

/** The order no longer fits the spending mandate (e.g. another of the customer's clients used the budget first). */
export class MandateExceededError extends Error {}

export interface SpendLimits {
  maxOrderCents: number;
  dailyCapCents: number;
}

const DAY_MS = 24 * 3600_000;
const MAX_ORDERS_PER_CUSTOMER = 100;
const MAX_IDEMPOTENCY_KEYS = 50_000;

export interface PlaceOrderRequest {
  customerKey: string;
  subject: string;
  /** Anonymous (session) carts to fold into the customer's cart first. */
  claimCartKeys: readonly string[];
  /** Retrying with the same key returns the original order instead of charging again (M6). */
  idempotencyKey?: string;
  /** Refuse unless the cart still has exactly this content: what the customer approved is what is bought. */
  expectedCartHash?: string;
  /** Default `customer_approval`. With `spending_mandate` the order is refused unless it fits the remaining budget. */
  authorizedBy?: Authorization;
}

/** Stable fingerprint of what is being bought; any change (item, quantity, price) changes it. */
export function cartHash(cart: Cart): string {
  const lines = [...cart.items].sort((a, b) => a.productId.localeCompare(b.productId)).map((i) => `${i.productId}:${i.quantity}:${i.unitPriceCents}`);
  return createHash("sha256").update(lines.join("|")).digest("hex");
}

export class CheckoutService {
  private readonly orders = new Map<string, Order[]>();
  private readonly byIdempotencyKey = new Map<string, Order>();

  constructor(
    private readonly carts: CartService,
    private readonly profiles: ProfileRepository,
    private readonly limits: SpendLimits = { maxOrderCents: 50_000, dailyCapCents: 100_000 },
    private readonly now: () => number = Date.now,
  ) {}

  /** Claims anonymous carts for the customer and returns what would be bought. Does not charge. */
  prepare(customerKey: string, claimCartKeys: readonly string[]): Cart {
    return this.carts.merge(claimCartKeys, customerKey);
  }

  profile(subject: string): CustomerProfile {
    const profile = this.profiles.find(subject);
    if (!profile) throw new NoProfileError();
    return profile;
  }

  /** Returns the order already placed under this key, if any. */
  existing(idempotencyKey: string): Order | undefined {
    return this.byIdempotencyKey.get(idempotencyKey);
  }

  placeOrder({ customerKey, subject, claimCartKeys, idempotencyKey, expectedCartHash, authorizedBy = "customer_approval" }: PlaceOrderRequest): { order: Order; replayed: boolean } {
    const prior = idempotencyKey ? this.byIdempotencyKey.get(idempotencyKey) : undefined;
    if (prior) return { order: prior, replayed: true };

    const profile = this.profiles.find(subject);
    if (!profile) throw new NoProfileError();

    const cart = this.carts.merge(claimCartKeys, customerKey);
    if (cart.items.length === 0) throw new EmptyCartError();
    if (expectedCartHash !== undefined && cartHash(cart) !== expectedCartHash) {
      throw new SpendLimitError("Your cart changed after you approved it; please review and approve again");
    }
    this.enforceLimits(subject, cart.totalCents);
    // Checked and recorded in the same synchronous step: concurrent checkouts from several of the customer's clients
    // cannot both fit into the same remaining budget. (With a shared database this must be one transaction.)
    if (authorizedBy === "spending_mandate" && !this.mandateCovers(subject, cart.totalCents)) {
      throw new MandateExceededError("This purchase no longer fits your spending mandate; it needs your approval");
    }

    const order: Order = {
      orderId: `ord_${randomBytes(9).toString("hex")}`,
      subject,
      createdAt: this.now(),
      authorizedBy,
      ...cart,
      shippingAddress: profile.shippingAddress,
      payment: profile.payment,
    };
    this.orders.set(customerKey, [...(this.orders.get(customerKey) ?? []), order].slice(-MAX_ORDERS_PER_CUSTOMER));
    this.carts.clear(customerKey);
    if (idempotencyKey) {
      this.byIdempotencyKey.set(idempotencyKey, order);
      if (this.byIdempotencyKey.size > MAX_IDEMPOTENCY_KEYS) this.byIdempotencyKey.delete(this.byIdempotencyKey.keys().next().value!);
    }
    return { order, replayed: false };
  }

  ordersFor(customerKey: string): Order[] {
    return this.orders.get(customerKey) ?? [];
  }

  /** The customer's most recent order if placed within `withinMs` (to answer a retried checkout). */
  recentOrder(subject: string, withinMs: number): Order | undefined {
    const last = (this.orders.get(`customer:${subject}`) ?? []).at(-1);
    return last && this.now() - last.createdAt <= withinMs ? last : undefined;
  }

  /** The customer's spending mandate and how much of it is left in the current window. Zero mandate if none. */
  mandateStatus(subject: string): MandateStatus {
    const mandate = this.profiles.find(subject)?.mandate ?? { amountCents: 0, windowMs: DAY_MS };
    const since = this.now() - mandate.windowMs;
    const usedCents = (this.orders.get(`customer:${subject}`) ?? [])
      .filter((o) => o.authorizedBy === "spending_mandate" && o.createdAt >= since)
      .reduce((s, o) => s + o.totalCents, 0);
    return { ...mandate, usedCents, remainingCents: Math.max(0, mandate.amountCents - usedCents) };
  }

  /** True when an order of this total can be placed without asking the customer. */
  mandateCovers(subject: string, totalCents: number): boolean {
    return totalCents > 0 && totalCents <= this.mandateStatus(subject).remainingCents;
  }

  /** Total spent by this customer in the last 24 hours. */
  spentLast24h(subject: string): number {
    const since = this.now() - DAY_MS;
    return (this.orders.get(`customer:${subject}`) ?? []).filter((o) => o.createdAt >= since).reduce((s, o) => s + o.totalCents, 0);
  }

  /** Throws SpendLimitError if an order of this total could not be placed now (checked again when placing). */
  assertWithinLimits(subject: string, totalCents: number) {
    this.enforceLimits(subject, totalCents);
  }

  private enforceLimits(subject: string, totalCents: number) {
    if (totalCents > this.limits.maxOrderCents) {
      throw new SpendLimitError(`Orders over $${(this.limits.maxOrderCents / 100).toFixed(2)} cannot be placed through an agent; use the website`);
    }
    if (this.spentLast24h(subject) + totalCents > this.limits.dailyCapCents) {
      throw new SpendLimitError("Daily spending limit for agent purchases reached; use the website or try again tomorrow");
    }
  }
}

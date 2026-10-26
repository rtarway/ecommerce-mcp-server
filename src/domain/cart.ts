import type { Catalog } from "./catalog.js";

export interface CartItem {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  /**
   * Which of the customer's agents added this line (several agents share one customer cart). Labels, not proof:
   * the app name is self-declared. Not part of what an approval covers (products and quantities are).
   */
  addedBy?: string[];
}

export interface Cart {
  items: CartItem[];
  totalCents: number;
}

export class UnknownProductError extends Error {
  constructor(productId: string) {
    super(`Unknown product: ${productId}`);
  }
}

export class InvalidQuantityError extends Error {
  constructor(quantity: number) {
    super(`Quantity must be an integer between 1 and ${MAX_QUANTITY}, got ${quantity}`);
  }
}

export class CartLimitError extends Error {}

export class NotInCartError extends Error {
  constructor(productId: string) {
    super(`Not in your cart: ${productId}`);
  }
}

const MAX_QUANTITY = 10;
const MAX_LINES = 25;

export interface CartLimits {
  /** Idle lifetime of carts keyed `session:*` (anonymous visitors). */
  anonymousIdleMs: number;
  customerIdleMs: number;
  maxCarts: number;
}

const DEFAULT_LIMITS: CartLimits = { anonymousIdleMs: 2 * 3600_000, customerIdleMs: 24 * 3600_000, maxCarts: 50_000 };

interface Stored {
  lines: Map<string, number>;
  /** productId -> agents that added it. */
  addedBy: Map<string, Set<string>>;
  touched: number;
}

const isAnonymous = (key: string) => key.startsWith("session:");

/**
 * In-memory carts (POC). Bounded (H2): idle carts expire, a cart has few lines, and the total is capped.
 * At the cap a flood of anonymous carts can neither evict customers nor other visitors: new anonymous
 * carts are refused instead, while a customer cart may displace the oldest anonymous one.
 */
export class CartService {
  private readonly carts = new Map<string, Stored>();
  private lastSweep = 0;

  constructor(
    private readonly catalog: Catalog,
    private readonly limits: CartLimits = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): Cart {
    const stored = this.live(key);
    const items: CartItem[] = [];
    for (const [productId, quantity] of stored?.lines ?? []) {
      const product = this.catalog.get(productId);
      const agents = stored?.addedBy.get(productId);
      if (product) items.push({ productId, name: product.name, quantity, unitPriceCents: product.priceCents, ...(agents?.size ? { addedBy: [...agents].sort() } : {}) });
    }
    return { items, totalCents: items.reduce((sum, i) => sum + i.quantity * i.unitPriceCents, 0) };
  }

  add(key: string, productId: string, quantity: number, addedBy?: string): Cart {
    if (!this.catalog.get(productId)) throw new UnknownProductError(productId);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) throw new InvalidQuantityError(quantity);
    const stored = this.live(key) ?? this.create(key);
    if (!stored.lines.has(productId) && stored.lines.size >= MAX_LINES) throw new CartLimitError(`A cart can hold at most ${MAX_LINES} different products`);
    stored.lines.set(productId, Math.min(MAX_QUANTITY, (stored.lines.get(productId) ?? 0) + quantity));
    if (addedBy) stored.addedBy.set(productId, new Set([...(stored.addedBy.get(productId) ?? []), addedBy]));
    stored.touched = this.now();
    return this.get(key);
  }

  /**
   * Takes `quantity` of a product out of the cart, or the whole line when `quantity` is omitted or covers it.
   * Lets customers drop items they did not ask for (a misbehaving agent, a thief, an older session).
   */
  remove(key: string, productId: string, quantity?: number): Cart {
    if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY)) throw new InvalidQuantityError(quantity);
    const stored = this.live(key);
    const current = stored?.lines.get(productId);
    if (!stored || current === undefined) throw new NotInCartError(productId);
    if (quantity === undefined || quantity >= current) {
      stored.lines.delete(productId);
      stored.addedBy.delete(productId);
    }
    else stored.lines.set(productId, current - quantity);
    stored.touched = this.now();
    return this.get(key);
  }

  /** Moves every source cart's items into the target cart and empties the sources. */
  merge(sourceKeys: readonly string[], targetKey: string): Cart {
    const sources = sourceKeys.filter((k) => k !== targetKey && this.live(k));
    if (sources.length > 0 || this.live(targetKey)) {
      const target = this.live(targetKey) ?? this.create(targetKey);
      for (const source of sources) {
        for (const [productId, quantity] of this.live(source)?.lines ?? []) {
          if (!target.lines.has(productId) && target.lines.size >= MAX_LINES) continue;
          target.lines.set(productId, Math.min(MAX_QUANTITY, (target.lines.get(productId) ?? 0) + quantity));
          const agents = this.live(source)?.addedBy.get(productId);
          if (agents?.size) target.addedBy.set(productId, new Set([...(target.addedBy.get(productId) ?? []), ...agents]));
        }
        this.carts.delete(source);
      }
      target.touched = this.now();
    }
    return this.get(targetKey);
  }

  clear(key: string): void {
    this.carts.delete(key);
  }

  get size(): number {
    return this.carts.size;
  }

  private live(key: string): Stored | undefined {
    const stored = this.carts.get(key);
    if (!stored) return undefined;
    if (this.expired(key, stored, this.now())) {
      this.carts.delete(key);
      return undefined;
    }
    return stored;
  }

  private expired(key: string, s: Stored, t: number) {
    return t - s.touched > (isAnonymous(key) ? this.limits.anonymousIdleMs : this.limits.customerIdleMs);
  }

  private create(key: string): Stored {
    this.sweep();
    if (this.carts.size >= this.limits.maxCarts) {
      const victim = isAnonymous(key) ? undefined : [...this.carts.keys()].find(isAnonymous);
      if (victim === undefined) throw new CartLimitError("The shop is busy right now; please try again shortly");
      this.carts.delete(victim);
    }
    const stored: Stored = { lines: new Map(), addedBy: new Map(), touched: this.now() };
    this.carts.set(key, stored);
    return stored;
  }

  private sweep() {
    const t = this.now();
    if (t - this.lastSweep < 1000) return;
    this.lastSweep = t;
    for (const [key, s] of this.carts) if (this.expired(key, s, t)) this.carts.delete(key);
  }
}

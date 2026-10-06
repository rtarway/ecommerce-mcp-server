import type { Catalog } from "./catalog.js";

export interface CartItem {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
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

const MAX_QUANTITY = 10;

export class CartService {
  private readonly carts = new Map<string, Map<string, number>>();

  constructor(private readonly catalog: Catalog) {}

  get(key: string): Cart {
    const items: CartItem[] = [];
    for (const [productId, quantity] of this.carts.get(key) ?? []) {
      const product = this.catalog.get(productId);
      if (product) items.push({ productId, name: product.name, quantity, unitPriceCents: product.priceCents });
    }
    return { items, totalCents: items.reduce((sum, i) => sum + i.quantity * i.unitPriceCents, 0) };
  }

  add(key: string, productId: string, quantity: number): Cart {
    if (!this.catalog.get(productId)) throw new UnknownProductError(productId);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) throw new InvalidQuantityError(quantity);
    const cart = this.carts.get(key) ?? new Map<string, number>();
    cart.set(productId, (cart.get(productId) ?? 0) + quantity);
    this.carts.set(key, cart);
    return this.get(key);
  }

  /** Moves every source cart's items into the target cart and empties the sources. */
  merge(sourceKeys: readonly string[], targetKey: string): Cart {
    const target = this.carts.get(targetKey) ?? new Map<string, number>();
    for (const source of sourceKeys) {
      if (source === targetKey) continue;
      for (const [productId, quantity] of this.carts.get(source) ?? []) {
        target.set(productId, (target.get(productId) ?? 0) + quantity);
      }
      this.carts.delete(source);
    }
    this.carts.set(targetKey, target);
    return this.get(targetKey);
  }

  clear(key: string): void {
    this.carts.delete(key);
  }
}

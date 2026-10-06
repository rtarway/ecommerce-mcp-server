import { CartService } from "./domain/cart.js";
import { Catalog } from "./domain/catalog.js";
import { CheckoutService } from "./domain/checkout.js";
import { PRODUCTS, PROFILES } from "./seed.js";

export interface Shop {
  catalog: Catalog;
  carts: CartService;
  checkout: CheckoutService;
}

/** Wires the in-memory shop. State lives for the life of the process (POC). */
export function buildShop(): Shop {
  const catalog = new Catalog(PRODUCTS);
  const carts = new CartService(catalog);
  const checkout = new CheckoutService(carts, { find: (username) => PROFILES[username] });
  return { catalog, carts, checkout };
}

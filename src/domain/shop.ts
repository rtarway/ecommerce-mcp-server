import { CartService, type CartLimits } from "./cart.js";
import { Catalog } from "./catalog.js";
import { CheckoutService, type SpendLimits, type SpendingMandate } from "./checkout.js";
import { DEMO_PROFILE, PRODUCTS } from "./seed.js";

export interface Shop {
  catalog: Catalog;
  carts: CartService;
  checkout: CheckoutService;
}

export interface ShopOptions {
  /** Keycloak user ids (`sub`) with a saved profile. */
  profileSubjects?: readonly string[];
  cartLimits?: CartLimits;
  spendLimits?: SpendLimits;
  /** Spending mandate on the demo customers' accounts (default: none, i.e. every purchase needs approval). */
  mandate?: SpendingMandate;
  now?: () => number;
}

/** Wires the in-memory shop. State lives for the life of the process (POC). */
export function buildShop({ profileSubjects = ["user-123"], cartLimits, spendLimits, mandate, now }: ShopOptions = {}): Shop {
  const catalog = new Catalog(PRODUCTS);
  const carts = new CartService(catalog, cartLimits, now);
  const subjects = new Set(profileSubjects);
  const profile = { ...DEMO_PROFILE, ...(mandate ? { mandate } : {}) };
  const checkout = new CheckoutService(carts, { find: (sub) => (subjects.has(sub) ? profile : undefined) }, spendLimits, now);
  return { catalog, carts, checkout };
}

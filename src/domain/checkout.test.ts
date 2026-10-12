import { beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "./catalog.js";
import { CartService } from "./cart.js";
import { CheckoutService, EmptyCartError, MandateExceededError, NoProfileError, SpendLimitError, cartHash, type CustomerProfile } from "./checkout.js";

const catalog = new Catalog([
  { id: "p1", name: "Shoes", category: "footwear", priceCents: 1000, description: "" },
  { id: "big", name: "Tent", category: "outdoor", priceCents: 30000, description: "" },
]);

const profile: CustomerProfile = {
  shippingAddress: { name: "Test User", line1: "1 Main St", city: "Springfield", postalCode: "12345", country: "US" },
  payment: { brand: "visa", last4: "4242" },
};
const SUB = "kc-user-1";

describe("CheckoutService", () => {
  let carts: CartService;
  let checkout: CheckoutService;
  let clock: number;
  beforeEach(() => {
    clock = 1_000_000;
    const now = () => clock;
    carts = new CartService(catalog, undefined, now);
    checkout = new CheckoutService(carts, { find: (sub) => (sub === SUB ? profile : undefined) }, { maxOrderCents: 50_000, dailyCapCents: 60_000 }, now);
  });
  const place = (extra: object = {}) => checkout.placeOrder({ customerKey: `customer:${SUB}`, subject: SUB, claimCartKeys: [], ...extra });

  it("places an order from the customer's cart using the saved profile, then empties the cart", () => {
    carts.add(`customer:${SUB}`, "p1", 2);
    const { order, replayed } = place();
    expect(replayed).toBe(false);
    expect(order.totalCents).toBe(2000);
    expect(order.subject).toBe(SUB);
    expect(order.shippingAddress).toEqual(profile.shippingAddress);
    expect(order.payment).toEqual({ brand: "visa", last4: "4242" });
    expect(order.orderId).toMatch(/^ord_[a-z0-9]+$/);
    expect(carts.get(`customer:${SUB}`).items).toEqual([]);
  });

  it("claims anonymous session carts into the customer's cart before ordering", () => {
    carts.add("session:s1", "p1", 1);
    carts.add(`customer:${SUB}`, "p1", 1);
    expect(place({ claimCartKeys: ["session:s1"] }).order.totalCents).toBe(2000);
    expect(carts.get("session:s1").items).toEqual([]);
  });

  it("rejects an empty cart", () => {
    expect(() => place()).toThrow(EmptyCartError);
  });

  it("looks the profile up by immutable subject: a username-alike gets nothing (H4)", () => {
    carts.add("customer:testuser", "p1", 1);
    expect(() => checkout.placeOrder({ customerKey: "customer:testuser", subject: "testuser", claimCartKeys: [] })).toThrow(NoProfileError);
    expect(carts.get("customer:testuser").items).toHaveLength(1);
  });

  it("is idempotent: the same key returns the first order and never charges twice (M6)", () => {
    carts.add(`customer:${SUB}`, "p1", 1);
    const first = place({ idempotencyKey: "k1" });
    carts.add(`customer:${SUB}`, "p1", 3);
    const retry = place({ idempotencyKey: "k1" });
    expect(retry.replayed).toBe(true);
    expect(retry.order.orderId).toBe(first.order.orderId);
    expect(checkout.ordersFor(`customer:${SUB}`)).toHaveLength(1);
    expect(carts.get(`customer:${SUB}`).items[0]?.quantity).toBe(3); // untouched
  });

  it("refuses to buy a cart that differs from what was approved", () => {
    carts.add(`customer:${SUB}`, "p1", 1);
    const approved = cartHash(carts.get(`customer:${SUB}`));
    carts.add(`customer:${SUB}`, "p1", 1);
    expect(() => place({ expectedCartHash: approved })).toThrow(/changed after you approved/);
    expect(carts.get(`customer:${SUB}`).items[0]?.quantity).toBe(2);
  });

  it("caps a single order and the rolling 24h total", () => {
    carts.add(`customer:${SUB}`, "big", 2); // $600 > $500
    expect(() => place()).toThrow(SpendLimitError);
    carts.clear(`customer:${SUB}`);
    carts.add(`customer:${SUB}`, "big", 1);
    place(); // $300 of $600
    carts.add(`customer:${SUB}`, "big", 1);
    place(); // $600 of $600
    carts.add(`customer:${SUB}`, "p1", 1);
    expect(() => place()).toThrow(/Daily spending limit/);
    clock += 25 * 3600_000;
    carts.add(`customer:${SUB}`, "p1", 1); // (the old cart expired too)
    expect(place().order.totalCents).toBe(1000);
  });

  it("has a zero mandate by default: nothing is covered without approval", () => {
    expect(checkout.mandateStatus(SUB)).toMatchObject({ amountCents: 0, usedCents: 0, remainingCents: 0 });
    expect(checkout.mandateCovers(SUB, 1)).toBe(false);
    carts.add(`customer:${SUB}`, "p1", 1);
    expect(() => place({ authorizedBy: "spending_mandate" })).toThrow(MandateExceededError);
    expect(carts.get(`customer:${SUB}`).items).toHaveLength(1); // untouched
  });

  describe("with a spending mandate", () => {
    let mc: CheckoutService;
    beforeEach(() => {
      const withMandate = { ...profile, mandate: { amountCents: 2500, windowMs: 3600_000 } }; // $25 per hour
      mc = new CheckoutService(carts, { find: (sub) => (sub === SUB ? withMandate : undefined) }, { maxOrderCents: 50_000, dailyCapCents: 60_000 }, () => clock);
    });
    const placeM = (authorizedBy: "spending_mandate" | "customer_approval") => mc.placeOrder({ customerKey: `customer:${SUB}`, subject: SUB, claimCartKeys: [], authorizedBy });

    it("only mandate-authorised orders use the budget, and the budget refills as the window rolls", () => {
      carts.add(`customer:${SUB}`, "p1", 1); // $10
      placeM("spending_mandate");
      expect(mc.mandateStatus(SUB)).toMatchObject({ usedCents: 1000, remainingCents: 1500 });
      carts.add(`customer:${SUB}`, "p1", 3); // $30, approved by the customer: does not touch the mandate
      expect(placeM("customer_approval").order.authorizedBy).toBe("customer_approval");
      expect(mc.mandateStatus(SUB).remainingCents).toBe(1500);
      clock += 3600_001;
      expect(mc.mandateStatus(SUB).remainingCents).toBe(2500);
    });

    it("refuses a mandate order that no longer fits, atomically, without touching the cart", () => {
      carts.add(`customer:${SUB}`, "p1", 2); // $20
      placeM("spending_mandate");
      carts.add(`customer:${SUB}`, "p1", 1); // $10 > $5 left
      expect(mc.mandateCovers(SUB, 1000)).toBe(false);
      expect(() => placeM("spending_mandate")).toThrow(MandateExceededError);
      expect(carts.get(`customer:${SUB}`).items[0]?.quantity).toBe(1);
    });
  });

  it("finds the customer's recent order for answering retries", () => {
    carts.add(`customer:${SUB}`, "p1", 1);
    const { order } = place();
    expect(checkout.recentOrder(SUB, 60_000)?.orderId).toBe(order.orderId);
    clock += 120_000;
    expect(checkout.recentOrder(SUB, 60_000)).toBeUndefined();
  });

  it("hashes carts independent of order and sensitive to quantity and price", () => {
    const a = { items: [{ productId: "a", name: "", quantity: 1, unitPriceCents: 5 }, { productId: "b", name: "", quantity: 1, unitPriceCents: 5 }], totalCents: 10 };
    const b = { ...a, items: [...a.items].reverse() };
    expect(cartHash(a)).toBe(cartHash(b));
    expect(cartHash(a)).not.toBe(cartHash({ ...a, items: [{ ...a.items[0]!, quantity: 2 }, a.items[1]!] }));
    expect(cartHash(a)).not.toBe(cartHash({ ...a, items: [{ ...a.items[0]!, unitPriceCents: 6 }, a.items[1]!] }));
  });
});

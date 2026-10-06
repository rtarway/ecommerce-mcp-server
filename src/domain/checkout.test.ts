import { beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "./catalog.js";
import { CartService } from "./cart.js";
import { CheckoutService, EmptyCartError, NoProfileError, type CustomerProfile } from "./checkout.js";

const catalog = new Catalog([{ id: "p1", name: "Shoes", category: "footwear", priceCents: 1000, description: "" }]);

const profile: CustomerProfile = {
  shippingAddress: { name: "Test User", line1: "1 Main St", city: "Springfield", postalCode: "12345", country: "US" },
  payment: { brand: "visa", last4: "4242" },
};

describe("CheckoutService", () => {
  let carts: CartService;
  let checkout: CheckoutService;
  beforeEach(() => {
    carts = new CartService(catalog);
    checkout = new CheckoutService(carts, { find: (username) => (username === "testuser" ? profile : undefined) });
  });

  it("places an order from the customer's cart using the saved profile, then empties the cart", () => {
    carts.add("customer:c1", "p1", 2);
    const order = checkout.placeOrder({ customerKey: "customer:c1", username: "testuser", claimCartKeys: [] });
    expect(order.totalCents).toBe(2000);
    expect(order.items).toHaveLength(1);
    expect(order.shippingAddress).toEqual(profile.shippingAddress);
    expect(order.payment).toEqual({ brand: "visa", last4: "4242" });
    expect(order.orderId).toMatch(/^ord_[a-z0-9]+$/);
    expect(carts.get("customer:c1").items).toEqual([]);
  });

  it("claims anonymous session carts into the customer's cart before ordering", () => {
    carts.add("session:s1", "p1", 1);
    carts.add("customer:c1", "p1", 1);
    const order = checkout.placeOrder({ customerKey: "customer:c1", username: "testuser", claimCartKeys: ["session:s1"] });
    expect(order.totalCents).toBe(2000);
    expect(carts.get("session:s1").items).toEqual([]);
  });

  it("rejects an empty cart without touching state", () => {
    expect(() => checkout.placeOrder({ customerKey: "customer:c1", username: "testuser", claimCartKeys: [] })).toThrow(EmptyCartError);
  });

  it("rejects customers with no saved profile and keeps their cart", () => {
    carts.add("customer:c2", "p1", 1);
    expect(() => checkout.placeOrder({ customerKey: "customer:c2", username: "stranger", claimCartKeys: [] })).toThrow(NoProfileError);
    expect(carts.get("customer:c2").items).toHaveLength(1);
  });

  it("records orders per customer", () => {
    carts.add("customer:c1", "p1", 1);
    const order = checkout.placeOrder({ customerKey: "customer:c1", username: "testuser", claimCartKeys: [] });
    expect(checkout.ordersFor("customer:c1")).toEqual([order]);
  });
});

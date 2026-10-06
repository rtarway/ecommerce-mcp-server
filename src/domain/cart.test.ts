import { beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "./catalog.js";
import { CartService, UnknownProductError, InvalidQuantityError } from "./cart.js";

const catalog = new Catalog([
  { id: "p1", name: "Shoes", category: "footwear", priceCents: 1000, description: "" },
  { id: "p2", name: "Bottle", category: "outdoor", priceCents: 250, description: "" },
]);

describe("CartService", () => {
  let carts: CartService;
  beforeEach(() => {
    carts = new CartService(catalog);
  });

  it("starts empty", () => {
    expect(carts.get("a")).toEqual({ items: [], totalCents: 0 });
  });

  it("adds items and totals them", () => {
    carts.add("a", "p1", 2);
    const cart = carts.add("a", "p2", 1);
    expect(cart.items).toEqual([
      { productId: "p1", name: "Shoes", quantity: 2, unitPriceCents: 1000 },
      { productId: "p2", name: "Bottle", quantity: 1, unitPriceCents: 250 },
    ]);
    expect(cart.totalCents).toBe(2250);
  });

  it("increments quantity when the same product is added again", () => {
    carts.add("a", "p1", 1);
    expect(carts.add("a", "p1", 2).items[0]?.quantity).toBe(3);
  });

  it("keeps carts separate per key", () => {
    carts.add("a", "p1", 1);
    expect(carts.get("b").items).toEqual([]);
  });

  it("rejects unknown products and bad quantities", () => {
    expect(() => carts.add("a", "zzz", 1)).toThrow(UnknownProductError);
    expect(() => carts.add("a", "p1", 0)).toThrow(InvalidQuantityError);
    expect(() => carts.add("a", "p1", 1.5)).toThrow(InvalidQuantityError);
    expect(() => carts.add("a", "p1", 100)).toThrow(InvalidQuantityError);
  });

  it("merges source carts into a target and empties the sources", () => {
    carts.add("session:1", "p1", 1);
    carts.add("session:2", "p1", 2);
    carts.add("session:2", "p2", 1);
    carts.add("customer", "p2", 1);
    const merged = carts.merge(["session:1", "session:2"], "customer");
    expect(merged.items.find((i) => i.productId === "p1")?.quantity).toBe(3);
    expect(merged.items.find((i) => i.productId === "p2")?.quantity).toBe(2);
    expect(carts.get("session:1").items).toEqual([]);
    expect(carts.get("session:2").items).toEqual([]);
  });

  it("ignores the target key if it appears in the sources", () => {
    carts.add("a", "p1", 1);
    expect(carts.merge(["a"], "a").items).toHaveLength(1);
  });

  it("clears a cart", () => {
    carts.add("a", "p1", 1);
    carts.clear("a");
    expect(carts.get("a").items).toEqual([]);
  });
});

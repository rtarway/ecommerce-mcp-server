import { beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "../../../src/domain/catalog.js";
import { CartLimitError, CartService, NotInCartError, UnknownProductError, InvalidQuantityError } from "../../../src/domain/cart.js";
import { cartHash } from "../../../src/domain/checkout.js";

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

  it("removes a whole line when no quantity is given", () => {
    carts.add("a", "p1", 3);
    carts.add("a", "p2", 1);
    const cart = carts.remove("a", "p1");
    expect(cart.items.map((i) => i.productId)).toEqual(["p2"]);
    expect(cart.totalCents).toBe(250);
  });

  it("decrements a line, and drops it when the quantity covers it", () => {
    carts.add("a", "p1", 3);
    expect(carts.remove("a", "p1", 2).items[0]?.quantity).toBe(1);
    expect(carts.remove("a", "p1", 5).items).toEqual([]);
  });

  it("refuses to remove what is not in the cart, and bad quantities", () => {
    expect(() => carts.remove("a", "p1")).toThrow(NotInCartError);
    carts.add("a", "p1", 1);
    expect(() => carts.remove("a", "p2")).toThrow(NotInCartError);
    expect(() => carts.remove("a", "p1", 0)).toThrow(InvalidQuantityError);
    expect(() => carts.remove("a", "p1", 1.5)).toThrow(InvalidQuantityError);
    expect(carts.get("a").items).toHaveLength(1);
  });

  it("clears a cart", () => {
    carts.add("a", "p1", 1);
    carts.clear("a");
    expect(carts.get("a").items).toEqual([]);
  });
});

describe("CartService bounds (H2)", () => {
  const limits = { anonymousIdleMs: 1000, customerIdleMs: 5000, maxCarts: 3 };
  let clock = 0;
  let carts: CartService;
  beforeEach(() => {
    clock = 0;
    carts = new CartService(catalog, limits, () => clock);
  });

  it("expires idle anonymous carts sooner than customer carts", () => {
    carts.add("session:a", "p1", 1);
    carts.add("customer:c", "p1", 1);
    clock = 2000;
    expect(carts.get("session:a").items).toEqual([]);
    expect(carts.get("customer:c").items).toHaveLength(1);
    clock = 6000;
    expect(carts.get("customer:c").items).toEqual([]);
  });

  it("cannot remove from an expired cart", () => {
    carts.add("session:a", "p1", 1);
    clock = 2000;
    expect(() => carts.remove("session:a", "p1")).toThrow(NotInCartError);
  });

  it("activity keeps a cart alive", () => {
    carts.add("session:a", "p1", 1);
    clock = 800;
    carts.add("session:a", "p2", 1);
    clock = 1500;
    expect(carts.get("session:a").items).toHaveLength(2);
  });

  it("refuses new anonymous carts at capacity without evicting existing visitors", () => {
    for (const k of ["session:1", "session:2", "session:3"]) carts.add(k, "p1", 1);
    expect(() => carts.add("session:4", "p1", 1)).toThrow(CartLimitError);
    expect(carts.get("session:1").items).toHaveLength(1);
  });

  it("lets a customer cart displace an anonymous one, but never the reverse", () => {
    carts.add("customer:c", "p1", 1);
    carts.add("session:1", "p1", 1);
    carts.add("session:2", "p1", 1);
    carts.add("customer:d", "p1", 1); // evicts oldest anonymous (session:1)
    expect(carts.get("session:1").items).toEqual([]);
    expect(carts.get("customer:c").items).toHaveLength(1);
    expect(carts.size).toBe(3);
  });

  it("caps distinct lines per cart and clamps quantity", () => {
    const big = new Catalog(Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: "x", category: "c", priceCents: 1, description: "" })));
    const c = new CartService(big);
    for (let i = 0; i < 25; i++) c.add("a", `p${i}`, 1);
    expect(() => c.add("a", "p25", 1)).toThrow(CartLimitError);
    for (let i = 0; i < 5; i++) c.add("a", "p0", 10);
    expect(c.get("a").items[0]?.quantity).toBe(10);
  });

  it("records which agents added each line; removing the line forgets them; merges keep them", () => {
    carts.add("customer:c", "p1", 1, "Codex (client 8a1d8381)");
    carts.add("customer:c", "p1", 1, "claude-code (client ee0ac5bb)");
    carts.add("customer:c", "p2", 1);
    const items = carts.get("customer:c").items;
    expect(items.find((i) => i.productId === "p1")?.addedBy).toEqual(["Codex (client 8a1d8381)", "claude-code (client ee0ac5bb)"]);
    expect(items.find((i) => i.productId === "p2")?.addedBy).toBeUndefined();
    carts.remove("customer:c", "p1");
    carts.add("customer:c", "p1", 1);
    expect(carts.get("customer:c").items.find((i) => i.productId === "p1")?.addedBy).toBeUndefined();
    carts.add("session:s", "p2", 1, "Inspector (client mcp-test)");
    expect(carts.merge(["session:s"], "customer:c").items.find((i) => i.productId === "p2")?.addedBy).toEqual(["Inspector (client mcp-test)"]);
  });

  it("an approval covers products and quantities, not who added them", () => {
    carts.add("customer:x", "p1", 1, "app A");
    const before = cartHash(carts.get("customer:x"));
    carts.add("customer:y", "p1", 1);
    expect(cartHash(carts.get("customer:y"))).toBe(before);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildShop, type Shop } from "../shop.js";
import { createShopServer, type RequestContext } from "./server.js";
import type { Identity } from "../auth/tokens.js";

const customer: Identity = { subject: "c1", username: "testuser", clientId: "agent-a", scopes: ["openid", "ecommerce:checkout"] };

async function connect(shop: Shop, ctx: RequestContext) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createShopServer(shop, ctx).connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

describe("shop MCP server", () => {
  let shop: Shop;
  beforeEach(() => {
    shop = buildShop();
  });

  it("exposes exactly the three shopping tools", async () => {
    const client = await connect(shop, { sessionId: "s1" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["add_to_cart", "one_step_checkout", "product_search"]);
  });

  it("product_search works anonymously and returns structured results", async () => {
    const client = await connect(shop, {});
    const r = await client.callTool({ name: "product_search", arguments: { query: "running shoes", maxPrice: 100 } });
    const products = (r.structuredContent as { products: { id: string; price: number }[] }).products;
    expect(products.length).toBeGreaterThan(0);
    expect(products.every((p) => p.price <= 100)).toBe(true);
  });

  it("add_to_cart works anonymously within a session and persists across calls", async () => {
    const client = await connect(shop, { sessionId: "s1" });
    const id = shop.catalog.search({})[0]!.id;
    await client.callTool({ name: "add_to_cart", arguments: { productId: id, quantity: 1 } });
    const r = await client.callTool({ name: "add_to_cart", arguments: { productId: id, quantity: 2 } });
    expect((r.structuredContent as { cart: { items: { quantity: number }[] } }).cart.items[0]?.quantity).toBe(3);
    expect(shop.carts.get("session:s1").items).toHaveLength(1);
  });

  it("add_to_cart reports domain errors as tool errors, not protocol failures", async () => {
    const client = await connect(shop, { sessionId: "s1" });
    const r = await client.callTool({ name: "add_to_cart", arguments: { productId: "nope", quantity: 1 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Unknown product/);
  });

  it("add_to_cart without a session or login cannot know whose cart to use", async () => {
    const client = await connect(shop, {});
    const r = await client.callTool({ name: "add_to_cart", arguments: { productId: shop.catalog.search({})[0]!.id, quantity: 1 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/session/i);
  });

  it("an authenticated customer's cart is keyed by customer, not session", async () => {
    const client = await connect(shop, { sessionId: "s1", identity: customer });
    await client.callTool({ name: "add_to_cart", arguments: { productId: shop.catalog.search({})[0]!.id, quantity: 1 } });
    expect(shop.carts.get("customer:c1").items).toHaveLength(1);
    expect(shop.carts.get("session:s1").items).toHaveLength(0);
  });

  it("one_step_checkout claims the session cart and orders with the saved profile", async () => {
    const anon = await connect(shop, { sessionId: "s1" });
    await anon.callTool({ name: "add_to_cart", arguments: { productId: shop.catalog.search({})[0]!.id, quantity: 2 } });

    const authed = await connect(shop, { sessionId: "s1", identity: customer });
    const r = await authed.callTool({ name: "one_step_checkout", arguments: {} });
    expect(r.isError).toBeFalsy();
    const order = (r.structuredContent as { order: { orderId: string; payment: { last4: string }; shippingAddress: { city: string } } }).order;
    expect(order.orderId).toMatch(/^ord_/);
    expect(order.payment.last4).toBe("4242");
    expect(shop.carts.get("session:s1").items).toEqual([]);
  });

  it("one_step_checkout refuses without the checkout scope, even if called directly", async () => {
    const client = await connect(shop, { sessionId: "s1", identity: { ...customer, scopes: ["openid"] } });
    const r = await client.callTool({ name: "one_step_checkout", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/authoriz|scope/i);
  });

  it("one_step_checkout on an empty cart is a tool error", async () => {
    const client = await connect(shop, { sessionId: "s1", identity: customer });
    const r = await client.callTool({ name: "one_step_checkout", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/empty/i);
  });
});

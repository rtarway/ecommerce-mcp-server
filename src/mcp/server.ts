import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Identity } from "../auth/tokens.js";
import type { Cart } from "../domain/cart.js";
import type { Product } from "../domain/catalog.js";
import type { Order } from "../domain/checkout.js";
import type { Shop } from "../shop.js";

export const CHECKOUT_SCOPE = "ecommerce:checkout";

/** Who is calling. Anonymous visitors have only a sessionId; customers also have an identity. */
export interface RequestContext {
  sessionId?: string;
  identity?: Identity;
}

const dollars = (cents: number) => cents / 100;
const productView = (p: Product) => ({ id: p.id, name: p.name, category: p.category, price: dollars(p.priceCents), description: p.description });
const cartView = (c: Cart) => ({
  items: c.items.map((i) => ({ productId: i.productId, name: i.name, quantity: i.quantity, unitPrice: dollars(i.unitPriceCents) })),
  total: dollars(c.totalCents),
});
const orderView = (o: Order) => ({ ...cartView(o), orderId: o.orderId, shippingAddress: o.shippingAddress, payment: o.payment });

const ok = (summary: string, structured: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: `${summary}\n${JSON.stringify(structured, null, 2)}` }],
  structuredContent: structured,
});
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

/** Runs a handler, turning thrown domain errors into MCP tool errors the model can read. */
function guarded<A>(handler: (args: A) => ReturnType<typeof ok>) {
  return (args: A) => {
    try {
      return handler(args);
    } catch (err) {
      return fail(err instanceof Error ? err.message : "Unexpected error");
    }
  };
}

export function createShopServer(shop: Shop, ctx: RequestContext): McpServer {
  const server = new McpServer({ name: "ecommerce-mcp-server", version: "0.1.0" });

  const cartKey = (): string => {
    if (ctx.identity) return `customer:${ctx.identity.subject}`;
    if (ctx.sessionId) return `session:${ctx.sessionId}`;
    throw new Error("No session: start an MCP session before using the cart.");
  };

  server.registerTool(
    "product_search",
    {
      title: "Search products",
      description: "Search the product catalog. No login needed. All filters are optional.",
      inputSchema: {
        query: z.string().optional().describe("Words to look for in product name/description"),
        category: z.string().optional().describe("e.g. footwear, outdoor, apparel, electronics"),
        maxPrice: z.number().positive().optional().describe("Maximum price in dollars"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(({ query, category, maxPrice, limit }) => {
      const products = shop.catalog
        .search({ query, category, maxPriceCents: maxPrice === undefined ? undefined : Math.round(maxPrice * 100), limit: limit ?? 10 })
        .map(productView);
      return ok(`Found ${products.length} product(s).`, { products });
    }),
  );

  server.registerTool(
    "add_to_cart",
    {
      title: "Add to cart",
      description: "Add a product to your cart. No login needed; your cart follows your session.",
      inputSchema: {
        productId: z.string().describe("Product id from product_search"),
        quantity: z.number().int().min(1).max(10).default(1),
      },
    },
    guarded(({ productId, quantity }) => {
      const cart = cartView(shop.carts.add(cartKey(), productId, quantity));
      return ok(`Cart now has ${cart.items.length} line(s), total $${cart.total.toFixed(2)}.`, { cart });
    }),
  );

  server.registerTool(
    "one_step_checkout",
    {
      title: "One-step checkout",
      description:
        "Buy everything in your cart using the shipping address and payment method saved on the customer's account. " +
        "Requires the customer to sign in and consent to this agent purchasing on their behalf.",
      inputSchema: {},
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    guarded(() => {
      const { identity } = ctx;
      if (!identity || !identity.scopes.includes(CHECKOUT_SCOPE)) {
        throw new Error(`Not authorized: customer sign-in with the ${CHECKOUT_SCOPE} scope is required.`);
      }
      const order = shop.checkout.placeOrder({
        customerKey: `customer:${identity.subject}`,
        username: identity.username,
        claimCartKeys: ctx.sessionId ? [`session:${ctx.sessionId}`] : [],
      });
      return ok(`Order ${order.orderId} placed. Total $${(order.totalCents / 100).toFixed(2)}.`, { order: orderView(order) });
    }),
  );

  return server;
}

import { randomBytes } from "node:crypto";
import type { Cart, CartService } from "./cart.js";

export interface Address {
  name: string;
  line1: string;
  city: string;
  postalCode: string;
  country: string;
}

/** Only the non-sensitive parts of a saved card; the real card never lives in this service. */
export interface PaymentMethod {
  brand: string;
  last4: string;
}

export interface CustomerProfile {
  shippingAddress: Address;
  payment: PaymentMethod;
}

export interface ProfileRepository {
  find(username: string): CustomerProfile | undefined;
}

export interface Order extends Cart {
  orderId: string;
  shippingAddress: Address;
  payment: PaymentMethod;
}

export class EmptyCartError extends Error {
  constructor() {
    super("Your cart is empty");
  }
}

export class NoProfileError extends Error {
  constructor(username: string) {
    super(`No saved shipping address / payment method on the account for ${username}`);
  }
}

export interface PlaceOrderRequest {
  customerKey: string;
  username: string;
  /** Anonymous (session) carts to fold into the customer's cart first. */
  claimCartKeys: readonly string[];
}

export class CheckoutService {
  private readonly orders = new Map<string, Order[]>();

  constructor(
    private readonly carts: CartService,
    private readonly profiles: ProfileRepository,
  ) {}

  placeOrder({ customerKey, username, claimCartKeys }: PlaceOrderRequest): Order {
    const profile = this.profiles.find(username);
    if (!profile) throw new NoProfileError(username);

    const cart = this.carts.merge(claimCartKeys, customerKey);
    if (cart.items.length === 0) throw new EmptyCartError();

    const order: Order = {
      orderId: `ord_${randomBytes(6).toString("hex")}`,
      ...cart,
      shippingAddress: profile.shippingAddress,
      payment: profile.payment,
    };
    this.orders.set(customerKey, [...(this.orders.get(customerKey) ?? []), order]);
    this.carts.clear(customerKey);
    return order;
  }

  ordersFor(customerKey: string): Order[] {
    return this.orders.get(customerKey) ?? [];
  }
}

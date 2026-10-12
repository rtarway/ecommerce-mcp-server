import type { Order } from "../domain/checkout.js";
import type { Shop } from "../domain/shop.js";
import type { Approval, ApprovalService } from "./service.js";

/**
 * Places the order an approval covers: exactly the cart the customer saw (same hash), once (the approval id is the
 * idempotency key). Throws the domain error (spend cap, cart changed, empty) if it cannot be placed.
 */
export function placeApprovedOrder(shop: Shop, approvals: ApprovalService, approval: Approval, claimCartKeys: readonly string[] = []): { order: Order; replayed: boolean } {
  const result = shop.checkout.placeOrder({
    customerKey: `customer:${approval.subject}`,
    subject: approval.subject,
    claimCartKeys,
    idempotencyKey: approval.id,
    expectedCartHash: approval.cartHash,
  });
  approvals.consume(approval.id, result.order.orderId);
  return result;
}

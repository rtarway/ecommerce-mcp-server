/** A basket summary as the approval page shows it (with markup in a name, to test escaping). */
import type { ApprovalSummary } from "../../src/approval/service.js";

export const summary: ApprovalSummary = {
  items: [{ productId: "p1", name: "Shoes <b>", quantity: 2, unitPriceCents: 1000 }],
  totalCents: 2000,
  payment: { brand: "visa", last4: "4242" },
  shippingAddress: { name: "T", line1: "1 Main", city: "X", postalCode: "1", country: "US" },
};

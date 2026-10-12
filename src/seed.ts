import type { Product } from "./domain/catalog.js";
import type { CustomerProfile } from "./domain/checkout.js";

export const PRODUCTS: Product[] = [
  { id: "shoe-trail-001", name: "Trail Running Shoes", category: "footwear", priceCents: 8999, description: "Lightweight trail running shoes with aggressive grip" },
  { id: "shoe-road-002", name: "Road Running Shoes", category: "footwear", priceCents: 11999, description: "Cushioned road running shoes for daily mileage" },
  { id: "shoe-walk-003", name: "Everyday Walking Shoes", category: "footwear", priceCents: 6499, description: "Comfortable walking shoes for city streets" },
  { id: "bottle-001", name: "Insulated Water Bottle", category: "outdoor", priceCents: 2499, description: "1L stainless steel insulated bottle, keeps drinks cold for 24h" },
  { id: "pack-day-001", name: "Daypack 20L", category: "outdoor", priceCents: 5499, description: "20 litre daypack with rain cover" },
  { id: "tent-2p-001", name: "2-Person Backpacking Tent", category: "outdoor", priceCents: 24999, description: "Three-season lightweight tent for two" },
  { id: "jacket-rain-001", name: "Packable Rain Jacket", category: "apparel", priceCents: 7999, description: "Waterproof breathable jacket that packs into its pocket" },
  { id: "socks-wool-001", name: "Merino Wool Hiking Socks", category: "apparel", priceCents: 1899, description: "Cushioned merino wool socks, 2 pair pack" },
  { id: "watch-gps-001", name: "GPS Running Watch", category: "electronics", priceCents: 19999, description: "GPS watch with heart-rate and training plans" },
  { id: "light-head-001", name: "Rechargeable Headlamp", category: "electronics", priceCents: 3499, description: "400 lumen USB-C rechargeable headlamp" },
];

/** The saved website profile every demo customer shares (stand-in for the real account service). */
export const DEMO_PROFILE: CustomerProfile = {
  shippingAddress: { name: "Test User", line1: "1 Main Street", city: "Springfield", postalCode: "12345", country: "US" },
  payment: { brand: "visa", last4: "4242" },
};

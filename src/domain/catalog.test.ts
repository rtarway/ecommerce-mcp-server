import { describe, expect, it } from "vitest";
import { Catalog, type Product } from "./catalog.js";

const products: Product[] = [
  { id: "p1", name: "Trail Running Shoes", category: "footwear", priceCents: 8999, description: "Lightweight trail shoes" },
  { id: "p2", name: "Road Running Shoes", category: "footwear", priceCents: 11999, description: "Cushioned road shoes" },
  { id: "p3", name: "Water Bottle", category: "outdoor", priceCents: 1599, description: "1L insulated bottle" },
];

describe("Catalog.search", () => {
  const catalog = new Catalog(products);

  it("returns everything when no filters are given", () => {
    expect(catalog.search({}).map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("matches the query case-insensitively against name and description", () => {
    expect(catalog.search({ query: "TRAIL" }).map((p) => p.id)).toEqual(["p1"]);
    expect(catalog.search({ query: "insulated" }).map((p) => p.id)).toEqual(["p3"]);
  });

  it("requires every query word to match", () => {
    expect(catalog.search({ query: "running shoes" }).map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(catalog.search({ query: "running bottle" })).toEqual([]);
  });

  it("filters by category and max price", () => {
    expect(catalog.search({ category: "outdoor" }).map((p) => p.id)).toEqual(["p3"]);
    expect(catalog.search({ maxPriceCents: 10000 }).map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("caps results at limit", () => {
    expect(catalog.search({ limit: 1 })).toHaveLength(1);
  });

  it("looks products up by id", () => {
    expect(catalog.get("p2")?.name).toBe("Road Running Shoes");
    expect(catalog.get("nope")).toBeUndefined();
  });
});

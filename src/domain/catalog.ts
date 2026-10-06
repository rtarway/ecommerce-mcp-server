export interface Product {
  id: string;
  name: string;
  category: string;
  priceCents: number;
  description: string;
}

export interface SearchCriteria {
  query?: string;
  category?: string;
  maxPriceCents?: number;
  limit?: number;
}

export class Catalog {
  constructor(private readonly products: readonly Product[]) {}

  search({ query, category, maxPriceCents, limit }: SearchCriteria): Product[] {
    const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const results = this.products.filter((p) => {
      const haystack = `${p.name} ${p.description}`.toLowerCase();
      return (
        words.every((w) => haystack.includes(w)) &&
        (category === undefined || p.category === category) &&
        (maxPriceCents === undefined || p.priceCents <= maxPriceCents)
      );
    });
    return limit === undefined ? results : results.slice(0, limit);
  }

  get(id: string): Product | undefined {
    return this.products.find((p) => p.id === id);
  }
}

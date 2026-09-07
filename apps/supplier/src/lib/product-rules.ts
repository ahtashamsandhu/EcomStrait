import type { ProductInput } from "@/lib/product-actions";

/** Hard ceilings, mirrored by CHECK constraints on `products` (20260907120100). */
export const MAX_PRICE = 10_000_000;
export const MAX_STOCK = 10_000_000;

const PRICE_LABELS = {
  wholesale_price: "wholesale price",
  retail_price: "MSRP",
  map_price: "MAP",
} as const;

/**
 * Price and stock rules, shared with the product form (which runs them
 * client-side before submitting). Plain function, no server access, so it is
 * safe to import from a client component even though this is an actions file.
 *
 *  - every price is 0..MAX_PRICE, stock is a whole number 0..MAX_STOCK
 *  - with `requirePrices`, wholesale price, MSRP and stock must be given
 *    (the product form; the CSV importer stays lenient)
 *  - wholesale ≤ MAP ≤ MSRP wherever those values are present — a merchant
 *    can never be asked to advertise below what they pay, and the floor can
 *    never sit above the recommended price
 */
export function validatePricing(
  input: Pick<ProductInput, "wholesale_price" | "retail_price" | "map_price" | "stock">,
  opts: { requirePrices?: boolean; label?: string } = {},
): string | null {
  const label = opts.label ?? "Product";
  const prices: Partial<Record<keyof typeof PRICE_LABELS, number>> = {};
  for (const key of ["wholesale_price", "retail_price", "map_price"] as const) {
    const raw = input[key];
    if (raw == null || raw.trim() === "") {
      if (opts.requirePrices && key !== "map_price") return `${label}: ${PRICE_LABELS[key]} is required.`;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return `${label}: ${PRICE_LABELS[key]} can't be negative.`;
    if (n > MAX_PRICE) return `${label}: ${PRICE_LABELS[key]} must be at most ${MAX_PRICE.toLocaleString()}.`;
    prices[key] = n;
  }
  const { wholesale_price: w, retail_price: r, map_price: m } = prices;
  if (r != null && w != null && r < w) return `${label}: MSRP can't be lower than the wholesale price.`;
  if (m != null && w != null && m < w) return `${label}: MAP can't be lower than the wholesale price.`;
  if (r != null && m != null && r < m) return `${label}: MSRP can't be lower than the MAP.`;

  if (input.stock == null || input.stock.trim() === "") {
    if (opts.requirePrices) return `${label}: stock is required.`;
  } else {
    const n = Number(input.stock);
    if (!Number.isFinite(n) || n < 0) return `${label}: stock can't be negative.`;
    if (!Number.isInteger(n)) return `${label}: stock must be a whole number.`;
    if (n > MAX_STOCK) return `${label}: stock must be at most ${MAX_STOCK.toLocaleString()}.`;
  }
  return null;
}


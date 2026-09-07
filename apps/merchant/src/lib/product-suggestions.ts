import "server-only";
import {
  getPlatformTopSellers,
  getPublishedCatalog,
  findPublishedProducts,
  nicheKeywords,
  economicsFor,
  TOP_SELLER_WINDOW_DAYS,
  type CatalogProduct,
  type ProductMatch,
} from "@/lib/catalog";

export type ProductSuggestion = CatalogProduct & {
  unitsSold: number;
  marginPct: number | null;
  reason: string;
};

export type ProductSuggestionResult = {
  products: ProductSuggestion[];
  /**
   * True only when a category was actually requested AND real products
   * matching it were found — by category name, by a keyword of the phrase
   * in the category, or by a keyword in a product title (see `matchedBy`).
   * False either when no category was requested at all, or — this is the
   * case a caller needs to handle honestly — a category WAS requested but
   * matched nothing, so `products` fell back to genuine platform-wide
   * results instead. A caller must never present that fallback as if it
   * answered the specific category asked for.
   */
  matchedCategory: boolean;
  /**
   * Which tier produced the match: "category" when the products' own
   * category matched the phrase (whole or by keyword), "title" when only
   * product titles did ("sneakers" → "Retro Sneakers" under "Shoes") — a
   * caller can say "matched by product title" so the merchant knows it's
   * looser than a category hit. Null whenever `matchedCategory` is false.
   */
  matchedBy: "category" | "title" | null;
  /** Whatever category was asked for (trimmed), even when `matchedCategory`
   *  is false — so a caller can name it in an honest fallback message. */
  requestedCategory: string | null;
};

function scoreFor(p: { unitsSold: number; marginPct: number | null }): number {
  // Units sold dominates — platform sales signal is the whole point of this
  // (a pre-launch store has none of its own), margin breaks ties.
  return p.unitsSold * 2 + (p.marginPct ?? 0);
}

function reasonFor(unitsSold: number, marginPct: number | null): string {
  const parts: string[] = [];
  if (unitsSold > 0) parts.push(`${unitsSold} sold across the platform in the last ${TOP_SELLER_WINDOW_DAYS} days`);
  if (marginPct != null) parts.push(`~${marginPct}% margin`);
  return parts.join(", ") || "published and in stock";
}

function rank(pool: (CatalogProduct & { unitsSold: number })[], limit: number): ProductSuggestion[] {
  return pool
    .map((p) => {
      const marginPct = economicsFor(p).marginPct;
      return { ...p, marginPct, reason: reasonFor(p.unitsSold, marginPct) };
    })
    .sort((a, b) => scoreFor(b) - scoreFor(a))
    .slice(0, limit);
}

/**
 * Whether a product can be recommended at all: excluded by the caller, or
 * nothing left to sell. `available` is stock minus reserved — recommending
 * a product a merchant can't actually list an order against today is the
 * "confident 'sold 40 recently' on an out-of-stock item" failure.
 */
function sellable(p: CatalogProduct, exclude: Set<string>): boolean {
  return !exclude.has(p.id) && p.available > 0;
}

/**
 * Top sellers for one match tier, topped up from the published catalog
 * (ranked by margin alone, `unitsSold: 0`) when the tier has fewer than
 * `limit` products with sales history — better than an empty list for
 * exactly the merchant who needs this most: a niche too new to have sold.
 */
async function poolFor(match: ProductMatch | null, exclude: Set<string>, limit: number) {
  const top = (await getPlatformTopSellers({ match: match ?? undefined, limit: limit * 4 })).filter((p) =>
    sellable(p, exclude),
  );
  const pool: (CatalogProduct & { unitsSold: number })[] = [...top];
  if (pool.length < limit) {
    const extra = match
      ? await findPublishedProducts(match, 60)
      : (await getPublishedCatalog({}, { from: 0, to: 60 })).products;
    const seen = new Set(pool.map((p) => p.id));
    for (const p of extra) {
      if (seen.has(p.id) || !sellable(p, exclude)) continue;
      pool.push({ ...p, unitsSold: 0 });
    }
  }
  return pool;
}

/**
 * Recommend products for a store to add — the data side of the builder
 * chat's "suggest_products" intent (ecomai.ts classifies the request;
 * builder-actions.ts calls this and presents the result). Deterministic
 * ranking, no LLM involved in the ranking itself — same split as the
 * Analytics Agent (SQL for facts, the model only narrates).
 *
 * A requested category is a freeform phrase out of an AI conversation
 * ("smartphones", "women's garments", "sneakers"), never guaranteed to be
 * a real category string, so it's tried in three tiers, strictest first:
 * the whole phrase as a category name (case-insensitive), then any keyword
 * of it in a category, then any keyword in a product title. The first tier
 * with a sellable product wins and is reported in `matchedBy`; only when
 * all three miss does this fall back platform-wide, and it says so.
 */
export async function suggestProductsForStore(opts: {
  category?: string | null;
  excludeIds?: string[];
  limit?: number;
}): Promise<ProductSuggestionResult> {
  const limit = opts.limit ?? 5;
  const exclude = new Set(opts.excludeIds ?? []);
  const category = opts.category?.trim() || undefined;

  if (category) {
    const words = nicheKeywords(category);
    const tiers: { match: ProductMatch; by: "category" | "title" }[] = [
      { match: { kind: "category", value: category }, by: "category" },
      ...(words.length
        ? [
            { match: { kind: "category-words", words } as ProductMatch, by: "category" as const },
            { match: { kind: "title-words", words } as ProductMatch, by: "title" as const },
          ]
        : []),
    ];
    for (const tier of tiers) {
      const pool = await poolFor(tier.match, exclude, limit);
      // A category that was actually asked for and matched real products,
      // even if fewer than `limit` — still a genuine match, not a fallback.
      if (pool.length > 0) {
        return { products: rank(pool, limit), matchedCategory: true, matchedBy: tier.by, requestedCategory: category };
      }
    }
  }

  // Either no category was asked for, or nothing at all matched it across
  // all three tiers — genuinely platform-wide results are still more useful
  // than an empty list, but the caller MUST be told this is a fallback, not
  // a match, so it can say so honestly rather than presenting unrelated
  // products as if they were what was asked for. A real bug this fixed: a
  // merchant who pivoted to "smartphones" (no published stock at all —
  // real, not a matching bug) got shoes back with no indication they
  // weren't smartphones at all.
  const pool = await poolFor(null, exclude, limit);
  return { products: rank(pool, limit), matchedCategory: false, matchedBy: null, requestedCategory: category ?? null };
}

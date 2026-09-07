import { createClient } from "@ecomstrait/auth/server";
import { createAdminClient } from "@ecomstrait/db/admin";

export type CatalogProduct = {
  id: string;
  title: string;
  category: string | null;
  images: string[];
  retail_price: number | null;
  wholesale_price: number | null;
  supplier_id: string;
  supplier_name: string;
  /** Units a merchant could actually sell today. */
  available: number;
  /** Supplier's platform quality score, 0-100, when scored. */
  supplier_score: number | null;
};

/** Per-unit economics a merchant judges a product on. */
export type ProductEconomics = {
  cost: number | null;
  retail: number | null;
  profit: number | null;
  marginPct: number | null;
};

export function economicsFor(p: {
  retail_price: number | null;
  wholesale_price: number | null;
}): ProductEconomics {
  const retail = p.retail_price;
  const cost = p.wholesale_price;
  if (retail == null || cost == null || retail <= 0) {
    return { cost, retail, profit: null, marginPct: null };
  }
  const profit = Math.round((retail - cost) * 100) / 100;
  return { cost, retail, profit, marginPct: Math.round((profit / retail) * 100) };
}

const SELECT =
  "id, title, category, images, retail_price, wholesale_price, supplier_id, stock, reserved";

export function productImage(path?: string | null): string | null {
  if (!path) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return base ? `${base}/storage/v1/object/public/product-images/${path}` : null;
}

type RawProduct = Omit<CatalogProduct, "supplier_name" | "available" | "supplier_score"> & {
  stock?: number | null;
  reserved?: number | null;
};

async function withSupplierNames(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  rows: RawProduct[],
): Promise<CatalogProduct[]> {
  const supIds = [...new Set(rows.map((p) => p.supplier_id))];
  const names = new Map<string, string>();
  const scores = new Map<string, number | null>();
  if (supIds.length) {
    const { data } = await admin
      .from("suppliers")
      .select("id, business_name, quality_score")
      .in("id", supIds);
    (data ?? []).forEach((s) => {
      names.set(s.id, s.business_name ?? "Supplier");
      scores.set(s.id, s.quality_score);
    });
  }
  return rows.map((p) => ({
    ...p,
    supplier_name: names.get(p.supplier_id) ?? "Supplier",
    supplier_score: scores.get(p.supplier_id) ?? null,
    available: Math.max(0, (p.stock ?? 0) - (p.reserved ?? 0)),
  }));
}

export type CatalogFilters = {
  /** Free-text match on the product title. */
  search?: string;
  /** A supplier id, or "" / undefined for all suppliers. */
  supplierId?: string;
  /** A product category ("niche"), or "" / undefined for all. */
  category?: string;
  /**
   * "exact" (default) is correct for a real category value chosen from
   * `getCatalogFacets()`'s own dropdown (Find Suppliers) — it's guaranteed
   * to already match the DB's exact string. "ilike" is for a freeform niche
   * phrase pulled out of an AI conversation (`product-suggestions.ts`),
   * which is never guaranteed to match the DB's exact casing — a real bug
   * this fixed: a merchant's "smartphones" (lowercase, from chat) silently
   * matched nothing against the DB's "Smartphones", exactly as if the
   * category had no products at all, when case-insensitively it did.
   */
  categoryMatch?: "exact" | "ilike";
};

/** Strip LIKE wildcards so a typed `%` matches literally rather than everything. */
function likeSafe(term: string): string {
  return term.replace(/[%_\\]/g, " ").trim().slice(0, 80);
}

export type CatalogPage = { products: CatalogProduct[]; total: number };

/**
 * One page of published products across approved suppliers. `total` is the full
 * filtered count, so the pager can show "1–24 of 312" rather than capping at
 * whatever fits on screen.
 */
export async function getPublishedCatalog(
  filters: CatalogFilters = {},
  range?: { from: number; to: number },
): Promise<CatalogPage> {
  const admin = createAdminClient();
  if (!admin) return { products: [], total: 0 };

  const build = () => {
    let q = admin
      .from("products")
      .select(SELECT, { count: "exact" })
      .eq("status", "published");
    const search = likeSafe(filters.search ?? "");
    if (search) q = q.ilike("title", `%${search}%`);
    if (filters.supplierId) q = q.eq("supplier_id", filters.supplierId);
    if (filters.category) {
      q = filters.categoryMatch === "ilike" ? q.ilike("category", filters.category) : q.eq("category", filters.category);
    }
    return q.order("created_at", { ascending: false });
  };

  const { data, count } = range
    ? await build().range(range.from, range.to)
    : await build().limit(60);

  return {
    products: await withSupplierNames(admin, data ?? []),
    total: count ?? 0,
  };
}

export type CatalogFacets = {
  suppliers: { id: string; name: string }[];
  categories: string[];
};

/**
 * The supplier and category options to offer in the filter bar — derived from
 * what's actually published, so the dropdowns never list an empty combination.
 */
export async function getCatalogFacets(): Promise<CatalogFacets> {
  const admin = createAdminClient();
  if (!admin) return { suppliers: [], categories: [] };

  const { data } = await admin
    .from("products")
    .select("supplier_id, category")
    .eq("status", "published");
  const rows = data ?? [];

  const categories = [
    ...new Set(
      rows
        .map((r) => r.category?.trim())
        .filter((c): c is string => Boolean(c)),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const supplierIds = [...new Set(rows.map((r) => r.supplier_id))];
  const names = new Map<string, string>();
  if (supplierIds.length) {
    const { data: sup } = await admin
      .from("suppliers")
      .select("id, business_name")
      .in("id", supplierIds);
    (sup ?? []).forEach((s) => names.set(s.id, s.business_name ?? "Supplier"));
  }
  const suppliers = supplierIds
    .map((id) => ({ id, name: names.get(id) ?? "Supplier" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { suppliers, categories };
}

/**
 * Words in a niche phrase that say nothing about what's being sold — "an
 * online store for handmade leather bags" should match on `handmade`,
 * `leather`, `bag`, not on `online`/`store`/`for`.
 */
const NICHE_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "by", "from", "at", "into",
  "my", "our", "your", "their", "own", "some", "any", "all", "new", "best", "top", "good", "great",
  "store", "stores", "shop", "shops", "online", "ecommerce", "e-commerce", "website", "site", "brand", "business",
  "sell", "sells", "selling", "sale", "buy", "want", "like", "think", "maybe", "kind", "sort", "type",
  "product", "products", "item", "items", "goods", "stuff", "things", "thing", "collection", "range",
  "niche", "based", "focused", "focus", "premium", "quality", "cheap", "affordable", "luxury",
]);

/**
 * The meaningful words of a freeform niche phrase, ready for `ilike`:
 * lowercased, punctuation stripped, stopwords dropped, and a trailing plural
 * "s" removed so "bags"/"shoes" still hit "bag"/"shoe" (and vice versa —
 * `%bag%` matches both). Short tokens (< 3 chars after stemming) are
 * dropped: they match everything and nothing.
 */
export function nicheKeywords(niche: string): string[] {
  const out: string[] = [];
  for (const raw of niche.toLowerCase().split(/\s+/)) {
    let w = raw.replace(/'s$/u, "").replace(/[^\p{L}\p{N}-]/gu, "").replace(/^-+|-+$/g, "");
    if (!w || NICHE_STOPWORDS.has(w)) continue;
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    if (w.length < 3 || NICHE_STOPWORDS.has(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out.slice(0, 8);
}

/** `ilike` pattern for one keyword — wildcards already stripped by `nicheKeywords`. */
function likeWord(w: string): string {
  return `%${likeSafe(w)}%`;
}

/**
 * How to narrow the published catalog to "products for this phrase" — the
 * three tiers `suggestProductsForStore` walks in order, from strictest to
 * loosest, so it can tell the caller which one actually hit.
 */
export type ProductMatch =
  /** The whole phrase is a category name (case-insensitive) — "Shoes". */
  | { kind: "category"; value: string }
  /** Any keyword appears in the category — "women's garments" → Fashion? no; "leather bags" → "Bags" yes. */
  | { kind: "category-words"; words: string[] }
  /** Any keyword appears in the product title — "sneakers" → "Retro Sneakers". */
  | { kind: "title-words"; words: string[] };

function publishedProducts(admin: NonNullable<ReturnType<typeof createAdminClient>>) {
  return admin.from("products").select(SELECT).eq("status", "published");
}
type ProductsQuery = ReturnType<typeof publishedProducts>;

function applyMatch(q: ProductsQuery, match: ProductMatch): ProductsQuery {
  switch (match.kind) {
    case "category":
      return q.ilike("category", likeSafe(match.value));
    case "category-words":
      return q.or(match.words.map((w) => `category.ilike.${likeWord(w)}`).join(","));
    case "title-words":
      return q.or(match.words.map((w) => `title.ilike.${likeWord(w)}`).join(","));
  }
}

/**
 * Published products narrowed by one `ProductMatch` tier, newest first —
 * the catalog-side counterpart of `getPlatformTopSellers({ match })` for a
 * niche with no sales history yet.
 */
export async function findPublishedProducts(match: ProductMatch, limit = 60): Promise<CatalogProduct[]> {
  const admin = createAdminClient();
  if (!admin) return [];
  if (match.kind !== "category" && !match.words.length) return [];
  const { data } = await applyMatch(publishedProducts(admin), match)
    .order("created_at", { ascending: false })
    .limit(limit);
  return withSupplierNames(admin, (data ?? []) as RawProduct[]);
}

export type AutoSelectResult = {
  products: CatalogProduct[];
  /**
   * False when nothing in the catalog matched any keyword of the niche and
   * `products` is just the newest published stock of any kind — a caller
   * must say so rather than present those as "products for your niche".
   */
  matchedNiche: boolean;
};

/**
 * Auto-pick published products that fit a niche. Every meaningful word of
 * the phrase is tried (OR-ilike across title and category), and rows that
 * hit more of those words rank first — "handmade leather bags" prefers a
 * "Handmade Leather Tote" over anything merely tagged "Handmade". Falls
 * back to the newest published products when nothing matches at all, and
 * says so via `matchedNiche`.
 */
export async function autoSelectProductsDetailed(niche: string, limit = 8): Promise<AutoSelectResult> {
  const admin = createAdminClient();
  if (!admin) return { products: [], matchedNiche: false };

  const words = nicheKeywords(niche);
  let rows: RawProduct[] = [];
  if (words.length) {
    const filter = words.flatMap((w) => [`title.ilike.${likeWord(w)}`, `category.ilike.${likeWord(w)}`]).join(",");
    const { data } = await admin
      .from("products")
      .select(SELECT)
      .eq("status", "published")
      .or(filter)
      .order("created_at", { ascending: false })
      .limit(Math.max(limit * 6, 40));
    const hits = (r: RawProduct) => {
      const hay = `${r.title} ${r.category ?? ""}`.toLowerCase();
      return words.filter((w) => hay.includes(w)).length;
    };
    const inStock = (r: RawProduct) => ((r.stock ?? 0) - (r.reserved ?? 0) > 0 ? 1 : 0);
    rows = ((data ?? []) as RawProduct[])
      .map((r, i) => ({ r, hits: hits(r), stock: inStock(r), i }))
      .sort((a, b) => b.hits - a.hits || b.stock - a.stock || a.i - b.i)
      .map((x) => x.r);
  }
  if (rows.length) {
    return { products: await withSupplierNames(admin, rows.slice(0, limit)), matchedNiche: true };
  }

  const { data } = await admin
    .from("products")
    .select(SELECT)
    .eq("status", "published")
    .order("created_at", { ascending: false })
    .limit(limit);
  return { products: await withSupplierNames(admin, (data ?? []) as RawProduct[]), matchedNiche: false };
}

/** `autoSelectProductsDetailed` for callers that don't need to know whether the niche matched. */
export async function autoSelectProducts(niche: string, limit = 8): Promise<CatalogProduct[]> {
  return (await autoSelectProductsDetailed(niche, limit)).products;
}

/**
 * Fetch specific published products by id, in no particular order — for a
 * caller that already knows which products it wants (e.g. the Co-Founder
 * orchestrator's `build_store` tool, resolving ids a prior `suggest_products`
 * tool call surfaced) rather than needing them ranked or filtered.
 */
export async function getProductsByIds(ids: string[]): Promise<CatalogProduct[]> {
  if (!ids.length) return [];
  const admin = createAdminClient();
  if (!admin) return [];
  const { data } = await admin.from("products").select(SELECT).eq("status", "published").in("id", ids);
  return withSupplierNames(admin, data ?? []);
}

/** The set of product ids the current user has selected. */
export async function getSelectedIds(): Promise<Set<string>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Set();
  const { data } = await supabase.from("selected_products").select("product_id").eq("user_id", user.id);
  return new Set((data ?? []).map((r) => r.product_id));
}

/** The current user's selected products, with details. */
export async function getSelectedProducts(): Promise<CatalogProduct[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data: sel } = await supabase.from("selected_products").select("product_id").eq("user_id", user.id);
  const ids = (sel ?? []).map((r) => r.product_id);
  if (!ids.length) return [];

  const admin = createAdminClient();
  if (!admin) return [];
  const { data } = await admin.from("products").select(SELECT).in("id", ids);
  return withSupplierNames(admin, data ?? []);
}

export type PlatformTopSeller = CatalogProduct & { unitsSold: number };

/** How far back "sold across the platform recently" looks. */
export const TOP_SELLER_WINDOW_DAYS = 90;

/**
 * Best-selling published products across the WHOLE platform — every
 * merchant, every supplier — ranked by real units sold over the last
 * `TOP_SELLER_WINDOW_DAYS` days. Never one merchant's own numbers, only the
 * aggregate: this is what makes it useful to a store with no sales history
 * of its own (a pre-launch build has none), and it's the signal behind both
 * the Product Suggestion agent and the "products similar stores sell well"
 * line in the co-founder snapshot.
 *
 * Plain queries rather than one join-with-a-filter-on-the-related-table —
 * same shape as the supplier orders list's "pull sort keys, then hydrate"
 * pattern (apps/supplier's `orders/page.tsx`), avoiding Supabase's fiddlier
 * embedded-resource filter syntax for something this occasional. The date
 * window lives on `orders` (order_items has no timestamp of its own), so
 * qualifying order ids are pulled first and the items fetched for those.
 */
export async function getPlatformTopSellers(
  opts: {
    /** Exact (case-insensitive) category — shorthand for `match: { kind: "category" }`. */
    category?: string;
    /** A looser tier than `category`; ignored when `category` is set. */
    match?: ProductMatch;
    limit?: number;
    windowDays?: number;
  } = {},
): Promise<PlatformTopSeller[]> {
  const admin = createAdminClient();
  if (!admin) return [];
  const limit = opts.limit ?? 8;
  const windowDays = opts.windowDays ?? TOP_SELLER_WINDOW_DAYS;
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  // Bounded scan, not a full aggregate query — fine at today's order volume;
  // revisit with a real SQL aggregate (or a materialized view) if this ever
  // shows up as slow.
  const { data: recent } = await admin
    .from("orders")
    .select("id")
    .gte("created_at", since)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(5000);
  const orderIds = (recent ?? []).map((o) => o.id);
  if (!orderIds.length) return [];

  const unitsByProduct = new Map<string, number>();
  // `.in()` goes into the request URL, so keep each batch a sane size.
  const BATCH = 300;
  for (let i = 0; i < orderIds.length; i += BATCH) {
    const { data: items } = await admin
      .from("order_items")
      .select("order_id, product_id, quantity")
      .in("order_id", orderIds.slice(i, i + BATCH))
      .not("product_id", "is", null)
      .limit(20000);
    for (const it of items ?? []) {
      if (!it.product_id) continue;
      unitsByProduct.set(it.product_id, (unitsByProduct.get(it.product_id) ?? 0) + it.quantity);
    }
  }
  if (!unitsByProduct.size) return [];

  // Headroom before the published/category filter below trims some out.
  const topIds = [...unitsByProduct.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit * 4)
    .map(([id]) => id);

  let productsQuery = publishedProducts(admin).in("id", topIds);
  // ilike, not eq: the callers match a freeform niche phrase from an AI
  // conversation against the DB's own category string — never guaranteed
  // to be the same case.
  const match: ProductMatch | undefined = opts.category ? { kind: "category", value: opts.category } : opts.match;
  if (match) productsQuery = applyMatch(productsQuery, match);
  const { data: rows } = await productsQuery;

  const withNames = await withSupplierNames(admin, (rows ?? []) as RawProduct[]);
  return withNames
    .map((p) => ({ ...p, unitsSold: unitsByProduct.get(p.id) ?? 0 }))
    .sort((a, b) => b.unitsSold - a.unitsSold)
    .slice(0, limit);
}

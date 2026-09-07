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

/** Auto-pick published products that fit a niche (falls back to any published). */
export async function autoSelectProducts(niche: string, limit = 8): Promise<CatalogProduct[]> {
  const admin = createAdminClient();
  if (!admin) return [];

  const term = niche
    .toLowerCase()
    .split(/\s+/)
    .find((w) => w.length > 2);

  let rows: RawProduct[] = [];
  if (term) {
    const { data } = await admin
      .from("products")
      .select(SELECT)
      .eq("status", "published")
      .or(`title.ilike.%${term}%,category.ilike.%${term}%`)
      .limit(limit);
    rows = data ?? [];
  }
  if (rows.length === 0) {
    const { data } = await admin
      .from("products")
      .select(SELECT)
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(limit);
    rows = data ?? [];
  }
  return withSupplierNames(admin, rows.slice(0, limit));
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

/**
 * Best-selling published products across the WHOLE platform — every
 * merchant, every supplier — ranked by real units sold. Never one
 * merchant's own numbers, only the aggregate: this is what makes it useful
 * to a store with no sales history of its own (a pre-launch build has
 * none), and it's the signal behind both the Product Suggestion agent and
 * the "products similar stores sell well" line in the co-founder snapshot.
 *
 * Two plain queries rather than one join-with-a-filter-on-the-related-table
 * — same shape as the supplier orders list's "pull sort keys, then hydrate"
 * pattern (apps/supplier's `orders/page.tsx`), avoiding Supabase's fiddlier
 * embedded-resource filter syntax for something this occasional.
 */
export async function getPlatformTopSellers(
  opts: { category?: string; limit?: number } = {},
): Promise<PlatformTopSeller[]> {
  const admin = createAdminClient();
  if (!admin) return [];
  const limit = opts.limit ?? 8;

  const { data: cancelled } = await admin.from("orders").select("id").eq("status", "cancelled");
  const cancelledIds = new Set((cancelled ?? []).map((o) => o.id));

  // Bounded scan, not a full aggregate query — fine at today's order volume;
  // revisit with a real SQL aggregate (or a materialized view) if this ever
  // shows up as slow.
  const { data: items } = await admin
    .from("order_items")
    .select("order_id, product_id, quantity")
    .not("product_id", "is", null)
    .limit(20000);

  const unitsByProduct = new Map<string, number>();
  for (const it of items ?? []) {
    if (!it.product_id || cancelledIds.has(it.order_id)) continue;
    unitsByProduct.set(it.product_id, (unitsByProduct.get(it.product_id) ?? 0) + it.quantity);
  }
  if (!unitsByProduct.size) return [];

  // Headroom before the published/category filter below trims some out.
  const topIds = [...unitsByProduct.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit * 4)
    .map(([id]) => id);

  let productsQuery = admin.from("products").select(SELECT).eq("status", "published").in("id", topIds);
  // ilike, not eq: this function's only caller is product-suggestions.ts,
  // matching a freeform niche phrase from an AI conversation against the
  // DB's own category string — never guaranteed to be the same case.
  if (opts.category) productsQuery = productsQuery.ilike("category", opts.category);
  const { data: rows } = await productsQuery;

  const withNames = await withSupplierNames(admin, (rows ?? []) as RawProduct[]);
  return withNames
    .map((p) => ({ ...p, unitsSold: unitsByProduct.get(p.id) ?? 0 }))
    .sort((a, b) => b.unitsSold - a.unitsSold)
    .slice(0, limit);
}

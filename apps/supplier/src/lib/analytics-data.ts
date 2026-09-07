import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, RequestStatus, Supplier } from "@ecomstrait/db/types";
import { createAdminClient } from "@ecomstrait/db/admin";
import { computeQualityScore, PROFILE_FIELDS, type QualityResult } from "@/lib/quality";

export type SupplierAnalytics = {
  quality: QualityResult;
  requestsByDay: { date: string; count: number }[];
  statusCounts: { status: RequestStatus; count: number }[];
  categoryCounts: { category: string; count: number }[];
  inventory: { inStock: number; low: number; out: number };
  /** Titles of the low-stock published products (not out-of-stock — those are
   *  a separate bucket above), most-depleted-looking first isn't tracked, so
   *  just insertion order. Used to let the Co-Founder chat name 1-2 real
   *  products instead of only ever saying "some products are low on stock". */
  lowStockProductNames: string[];
  metrics: {
    totalRequests: number;
    openRequests: number;
    acceptanceRate: number | null;
    responseRate: number | null;
    avgResponseHours: number | null;
    publishedProducts: number;
    /** All products regardless of status (draft included) — catalog size,
     *  distinct from `publishedProducts` (what's actually listed/live). */
    totalProducts: number;
  };
};

const RESPONDED: RequestStatus[] = ["accepted", "declined", "proposed", "fulfilled"];
const ACCEPTED: RequestStatus[] = ["accepted", "fulfilled"];

export async function getSupplierAnalytics(
  supabase: SupabaseClient<Database>,
  supplier: Supplier,
): Promise<SupplierAnalytics> {
  const [{ data: products }, { data: verification }, { data: requests }] = await Promise.all([
    supabase
      .from("products")
      // `title` added so the Co-Founder chat digest can name real low-stock
      // products instead of only ever reporting an aggregate count.
      .select("title, status, stock, reserved, low_stock_threshold, category")
      .eq("supplier_id", supplier.id),
    supabase
      .from("supplier_verification")
      .select("*")
      .eq("supplier_id", supplier.id)
      .maybeSingle(),
    supabase
      .from("product_requests")
      .select("status, created_at, updated_at")
      .eq("supplier_id", supplier.id),
  ]);

  const prods = products ?? [];
  const reqs = requests ?? [];

  // ---- Inventory ----
  // Published products only — matches the category chart right below, which
  // already filters the same way. Counting drafts here (as this used to)
  // meant a product not even listed anywhere could inflate "Out of stock"
  // and drag down the "Inventory health" quality factor below.
  let inStock = 0,
    low = 0,
    out = 0;
  const lowStockProductNames: string[] = [];
  for (const p of prods) {
    if (p.status !== "published") continue;
    const available = p.stock - p.reserved;
    if (available <= 0) out += 1;
    else if (available <= p.low_stock_threshold) {
      low += 1;
      if (p.title) lowStockProductNames.push(p.title);
    } else inStock += 1;
  }

  // ---- Categories (published products) ----
  const catMap = new Map<string, number>();
  for (const p of prods) {
    if (p.status !== "published") continue;
    const c = p.category?.trim() || "Uncategorised";
    catMap.set(c, (catMap.get(c) ?? 0) + 1);
  }
  const categoryCounts = [...catMap.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  // ---- Requests: status + trend + rates ----
  const statusOrder: RequestStatus[] = ["new", "proposed", "accepted", "fulfilled", "declined"];
  const statusCounts = statusOrder.map((status) => ({
    status,
    count: reqs.filter((r) => r.status === status).length,
  }));

  const days = 14;
  const now = new Date();
  const buckets = new Map<string, number>();
  for (let d = days - 1; d >= 0; d--) {
    const dt = new Date(now);
    dt.setDate(now.getDate() - d);
    buckets.set(dt.toISOString().slice(0, 10), 0);
  }
  for (const r of reqs) {
    const key = r.created_at.slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const requestsByDay = [...buckets.entries()].map(([date, count]) => ({ date, count }));

  const responded = reqs.filter((r) => RESPONDED.includes(r.status));
  const accepted = reqs.filter((r) => ACCEPTED.includes(r.status));
  const openRequests = reqs.filter((r) => r.status === "new" || r.status === "proposed").length;

  const avgResponseHours = responded.length
    ? Math.round(
        (responded.reduce(
          (s, r) => s + (new Date(r.updated_at).getTime() - new Date(r.created_at).getTime()),
          0,
        ) /
          responded.length /
          3_600_000) *
          10,
      ) / 10
    : null;

  // ---- Quality ----
  const profileFilled = PROFILE_FIELDS.filter((f) => {
    const v = supplier[f];
    return Array.isArray(v) ? v.length > 0 : Boolean(v && String(v).trim());
  }).length;
  const catNonEmpty = (supplier.product_categories ?? []).length > 0 ? 1 : 0;

  const verLevels = verification
    ? [
        verification.email_verified_at,
        verification.phone_verified_at,
        verification.documents_verified_at,
        verification.manual_reviewed_at,
        verification.badge_granted_at,
      ].filter(Boolean).length
    : 0;

  const publishedProducts = prods.filter((p) => p.status === "published").length;

  const quality = computeQualityScore({
    profileFilled: profileFilled + catNonEmpty,
    profileTotal: PROFILE_FIELDS.length + 1,
    verificationDone: verLevels,
    verificationTotal: 5,
    publishedProducts,
    // `inStock` above is now published-products-only (see the loop that
    // sets it) — `productsTotal` here must be scoped the same way, or the
    // ratio would be pulled down by draft products that were never at risk
    // of a stock-out in the first place, since nothing was ever listed.
    productsTotal: publishedProducts,
    inStockProducts: inStock,
    totalRequests: reqs.length,
    respondedRequests: responded.length,
    acceptedRequests: accepted.length,
  });

  return {
    quality,
    requestsByDay,
    statusCounts,
    categoryCounts,
    inventory: { inStock, low, out },
    lowStockProductNames,
    metrics: {
      totalRequests: reqs.length,
      openRequests,
      acceptanceRate: responded.length ? Math.round((accepted.length / responded.length) * 100) : null,
      responseRate: reqs.length ? Math.round((responded.length / reqs.length) * 100) : null,
      avgResponseHours,
      publishedProducts,
      totalProducts: prods.length,
    },
  };
}

/** Compact plain-text digest for the EcomAI Co-Founder chat — catalog/quality
 *  counterpart to revenue-analytics.ts's summarizeForAdvisor, so the advisor
 *  can actually answer "how many products do I have" / "what's low on
 *  stock" / "how's my catalog doing" instead of only ever seeing revenue. */
export function summarizeCatalogForAdvisor(a: SupplierAnalytics): string {
  // Name 1-2 real low-stock products (not just the count) so the Co-Founder
  // chat can lead with something specific ("Blue Canvas Tote and 2 others
  // are low on stock") instead of only an aggregate number.
  const lowStockNote =
    a.lowStockProductNames.length > 0
      ? (() => {
          const [first, second, ...rest] = a.lowStockProductNames;
          const named = second ? `${first} and ${second}` : first;
          return rest.length > 0 ? ` Low on stock: ${named} and ${rest.length} other(s).` : ` Low on stock: ${named}.`;
        })()
      : "";
  const lines = [
    `Catalog: ${a.metrics.totalProducts} total product(s), ${a.metrics.publishedProducts} published/live.`,
    `Stock (published products only): ${a.inventory.inStock} in stock, ${a.inventory.low} low stock, ${a.inventory.out} out of stock.${lowStockNote}`,
    a.categoryCounts.length
      ? `Top categories: ${a.categoryCounts.map((c) => `${c.category} (${c.count})`).join(", ")}.`
      : `No published categories yet.`,
    `Requests: ${a.metrics.openRequests} open of ${a.metrics.totalRequests} total, acceptance rate ${
      a.metrics.acceptanceRate != null ? `${a.metrics.acceptanceRate}%` : "n/a (no responses yet)"
    }.`,
    `Quality score: ${a.quality.score}/100 (${a.quality.tier}) — factors: ${a.quality.factors
      .map((f) => `${f.label} ${f.earned}/${f.max}`)
      .join(", ")}.`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Platform-wide demand signal (2026-09-07 capability audit, §10.2)
// ---------------------------------------------------------------------------

export type PlatformDemand = {
  /** Top categories by units sold across ALL suppliers in the last 90 days
   *  (order_items → orders with status <> 'cancelled' → products.category). */
  topCategories: { category: string; units: number }[];
  /** Open (new/proposed) buyer product requests platform-wide. */
  openRequests: number;
  /** Most-requested product names on those open requests. */
  topRequested: { name: string; count: number }[];
};

const DEMAND_DAYS = 90;
const DEMAND_SCAN_LIMIT = 5000;
const IN_CHUNK = 200;

function chunkIds<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * What merchants are actually buying and asking for across the whole
 * platform — the market context the merchant Co-Founder already gets
 * (`cofounder-snapshot.ts` platformTopSellers) and the supplier one never
 * had. Uses the service-role client because it deliberately crosses tenant
 * boundaries; only aggregates ever leave this function (category names and
 * counts), never another supplier's rows. `product_requests` has no
 * category column, so the request side is a count plus the most-requested
 * product names from `request_items` instead.
 *
 * Returns null when the admin client isn't configured, so the caller can
 * simply omit the line rather than show an empty one.
 */
export async function getPlatformDemand(): Promise<PlatformDemand | null> {
  const admin = createAdminClient();
  if (!admin) return null;

  const since = new Date(Date.now() - DEMAND_DAYS * 86_400_000).toISOString();
  const [{ data: recentOrders }, { data: openReqs }] = await Promise.all([
    admin
      .from("orders")
      .select("id")
      .neq("status", "cancelled")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(DEMAND_SCAN_LIMIT),
    admin.from("product_requests").select("id").in("status", ["new", "proposed"]).limit(DEMAND_SCAN_LIMIT),
  ]);

  // ---- Units by category, last 90 days ----
  const unitsByProduct = new Map<string, number>();
  for (const ids of chunkIds((recentOrders ?? []).map((o) => o.id))) {
    const { data: items } = await admin
      .from("order_items")
      .select("product_id, quantity")
      .in("order_id", ids)
      .not("product_id", "is", null);
    for (const it of items ?? []) {
      if (!it.product_id) continue;
      unitsByProduct.set(it.product_id, (unitsByProduct.get(it.product_id) ?? 0) + it.quantity);
    }
  }
  const unitsByCategory = new Map<string, number>();
  for (const ids of chunkIds([...unitsByProduct.keys()])) {
    const { data: prods } = await admin.from("products").select("id, category").in("id", ids);
    for (const p of prods ?? []) {
      const cat = p.category?.trim() || "Uncategorised";
      unitsByCategory.set(cat, (unitsByCategory.get(cat) ?? 0) + (unitsByProduct.get(p.id) ?? 0));
    }
  }
  const topCategories = [...unitsByCategory.entries()]
    .map(([category, units]) => ({ category, units }))
    .sort((a, b) => b.units - a.units)
    .slice(0, 5);

  // ---- Open requests: count + most-requested product names ----
  const requestedByName = new Map<string, number>();
  for (const ids of chunkIds((openReqs ?? []).map((r) => r.id))) {
    const { data: items } = await admin.from("request_items").select("product_name").in("request_id", ids);
    for (const it of items ?? []) {
      const name = it.product_name?.trim();
      if (!name) continue;
      requestedByName.set(name, (requestedByName.get(name) ?? 0) + 1);
    }
  }
  const topRequested = [...requestedByName.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  return { topCategories, openRequests: (openReqs ?? []).length, topRequested };
}

/** One compact line for the Co-Founder chat — labelled as market context so
 *  the model never mistakes platform-wide numbers for this supplier's own. */
export function summarizeDemandForAdvisor(d: PlatformDemand): string {
  const cats = d.topCategories.length
    ? `top categories by units sold in the last ${DEMAND_DAYS} days: ${d.topCategories
        .map((c) => `${c.category} (${c.units})`)
        .join(", ")}`
    : `no platform sales in the last ${DEMAND_DAYS} days`;
  const reqs =
    d.openRequests > 0
      ? `${d.openRequests} open buyer request(s) platform-wide${
          d.topRequested.length
            ? `, most-requested: ${d.topRequested.map((r) => `${r.name} (${r.count})`).join(", ")}`
            : ""
        }`
      : `no open buyer requests platform-wide right now`;
  return `Platform demand (market context, all suppliers): ${cats}; ${reqs}.`;
}

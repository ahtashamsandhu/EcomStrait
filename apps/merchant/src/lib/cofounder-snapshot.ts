import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ecomstrait/db/types";
import { createAdminClient } from "@ecomstrait/db/admin";
import { normalizePlan } from "@/lib/store-plan";
import { getPlatformTopSellers } from "@/lib/catalog";
import { getMerchantRevenueAnalytics, getMerchantOrderTrend } from "@/lib/revenue-analytics";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export type MerchantSnapshot = {
  storeCount: number;
  liveStoreCount: number;
  storeNames: string[];
  /** `net` is what's actually realized/settled (see revenue-analytics.ts);
   *  `gross` is total checkout value regardless of settlement — never quote
   *  `gross` to a merchant as "your revenue," it isn't. */
  revenue: { net: number; gross: number; orderCount: number; avgOrder: number; units: number };
  revenueByStore: { name: string; total: number }[];
  /** Gross checkout value + checkout count, last 30 days vs the 30 before
   *  (`store_orders`, status <> 'cancelled') — the time dimension the
   *  2026-09-07 capability audit (T7) found missing. Gross basis, never net. */
  trend: { last30: { gross: number; orders: number }; prior30: { gross: number; orders: number } };
  /** Per store: all-time checkout count, AOV (gross basis), and how many days
   *  since launch (`null` = still a draft). */
  storeStats: { name: string; orders: number; avgOrder: number; launchedDaysAgo: number | null }[];
  topProducts: { name: string; units: number; revenue: number }[];
  walletBalance: number;
  heldOrders: { count: number; value: number };
  /** What EcomStrait owes this merchant (COD orders' margin), not yet paid
   *  out in a settlement batch — Docs/Credits-Settlement-Plan.md §4. */
  pendingPayout: number;
  /** Placeholder-for-now (`customers.is_synthetic`) — see synthetic-signals.ts. */
  customers: { total: number; repeatCount: number; repeatPct: number; avgLifetimeValue: number };
  /** Placeholder-for-now (`store_traffic_events.is_synthetic`), last 30 days. */
  trafficBySource: { source: string; pct: number }[];
  storeDesign: { name: string; theme: string | null; brandColors: string[] }[];
  seoIssues: { storeName: string; issues: string[] }[];
  /** Real, platform-wide — never one merchant's own numbers. */
  platformTopSellers: { name: string; category: string | null; unitsSold: number; marginPct: number | null }[];
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type Plan = ReturnType<typeof normalizePlan>;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "your", "from", "that", "this", "our", "you", "are", "all", "new", "shop",
  "store", "online", "best", "quality", "premium", "collection", "collections", "products", "product",
  "more", "every", "into", "have", "has", "was", "were", "will", "than", "then", "them", "they", "their",
  "about", "welcome", "here", "where", "when", "what", "who", "how", "why", "one", "two", "each", "made",
  "make", "get", "just", "also", "very", "most", "some", "any", "can", "not", "but", "its", "out",
]);

const CTA_VERBS = ["shop", "discover", "browse", "order", "find", "get", "explore", "buy", "grab", "try"];

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

function norm(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Approximate a store's niche vocabulary: collection names + the first words of its about text. */
function nicheWords(plan: Plan): string[] {
  const fromCollections = plan.collections.flatMap((c) => words(c));
  const fromAbout = words((plan.about ?? "").split(/\s+/).slice(0, 25).join(" "));
  return [...new Set([...fromCollections, ...fromAbout])];
}

/**
 * Cheap, already-available SEO gaps for one store's plan — no new data needed.
 * Still a heuristic, not an audit (no keyword research, backlinks, page speed,
 * product/category/blog pages): length thresholds, whether the title carries
 * any word from the store's own niche vocabulary, whether the description has
 * a call to action, whether the about text mentions what the store sells, and
 * whether the title/description are copy-pasted across this merchant's other
 * stores (§1.8 of the 2026-09-07 capability audit).
 */
function seoIssuesFor(plan: Plan, siblings: Plan[]): string[] {
  const issues: string[] = [];
  const title = (plan.seoTitle ?? "").trim();
  const description = (plan.seoDescription ?? "").trim();
  const about = (plan.about ?? "").trim();
  const niche = nicheWords(plan);
  const collectionWords = [...new Set(plan.collections.flatMap((c) => words(c)))];

  if (title.length < 10) issues.push("SEO title is missing or very short");
  else if (niche.length && !niche.some((w) => title.toLowerCase().includes(w))) {
    issues.push("SEO title doesn't contain any word from the store's collections or niche — nobody searching for what it sells would match it");
  }

  if (description.length < 50) {
    issues.push("SEO description is missing or too short to be useful in search results");
  } else if (!CTA_VERBS.some((v) => new RegExp(`\\b${v}\\b`, "i").test(description))) {
    issues.push("SEO description has no call to action (shop / discover / browse / order / find / get / explore)");
  }

  if (about.length < 80) issues.push("About text is thin — search engines and customers both read it as low-effort");
  else if (collectionWords.length && !collectionWords.some((w) => about.toLowerCase().includes(w))) {
    issues.push("About text never mentions any of the store's collections — reads as generic copy");
  }

  if (title && siblings.some((o) => norm(o.seoTitle ?? "") === norm(title))) {
    issues.push("SEO title is identical to another of your stores' — duplicate titles compete against each other in search");
  }
  if (description && siblings.some((o) => norm(o.seoDescription ?? "") === norm(description))) {
    issues.push("SEO description is identical to another of your stores'");
  }
  return issues;
}

/**
 * Revenue/store/wallet/customer/traffic/SEO/design snapshot for a merchant —
 * everything the Co-Founder chat reasons over. Reuses the exact revenue
 * queries already proven on the Sales and Wallet pages instead of
 * re-deriving them; customer/traffic fields read the placeholder-for-now
 * tables `synthetic-signals.ts` writes on every order (see that file and
 * `cofounder-ai.ts`'s system prompt for how those get talked about).
 *
 * `admin` is optional and only used for the held-orders (low-credits) count
 * and the two new placeholder tables — `orders`/`customers`/
 * `store_traffic_events` have no merchant-facing RLS policy that fits this
 * cross-store aggregate read, same reason the Wallet page already reads
 * `orders` via the admin client rather than the session-scoped one.
 */
export async function getMerchantSnapshot(
  supabase: SupabaseClient<Database>,
  admin: Admin | null,
  userId: string,
): Promise<MerchantSnapshot> {
  const { data: stores } = await supabase
    .from("stores")
    .select("id, name, launched_at, theme, content")
    .eq("user_id", userId);
  const storeList = stores ?? [];
  const storeName = new Map(storeList.map((s) => [s.id, s.name ?? "Store"]));
  const storeIds = storeList.map((s) => s.id);
  const liveStoreCount = storeList.filter((s) => s.launched_at).length;

  // Revenue, wallet balance, held orders, and pending payout — shared with
  // the Sales page (revenue-analytics.ts) so the Co-Founder and the Sales
  // page always quote the same numbers, computed the same way.
  const [rev, orderTrend] = await Promise.all([
    getMerchantRevenueAnalytics(supabase, admin, userId, storeIds, storeName),
    getMerchantOrderTrend(supabase, storeIds, storeName),
  ]);
  const revenueByStore = rev.revenueByStore;
  const topProducts = rev.topProducts;
  const trend = { last30: orderTrend.last30, prior30: orderTrend.prior30 };
  const perStore = new Map(orderTrend.perStore.map((p) => [p.storeId, p]));
  const now = Date.now();
  const storeStats = storeList.map((s) => {
    const p = perStore.get(s.id);
    return {
      name: s.name ?? "Store",
      orders: p?.orders ?? 0,
      avgOrder: p?.avgOrder ?? 0,
      launchedDaysAgo: s.launched_at
        ? Math.max(0, Math.floor((now - new Date(s.launched_at).getTime()) / (24 * 60 * 60 * 1000)))
        : null,
    };
  });

  const storeDesign = storeList.map((s) => {
    const plan = normalizePlan(s.content);
    return { name: s.name ?? "Store", theme: s.theme, brandColors: plan.brandColors ?? [] };
  });
  const plans = storeList.map((s) => ({ id: s.id, name: s.name ?? "Store", plan: normalizePlan(s.content) }));
  const seoIssues = plans
    .map((p) => ({
      storeName: p.name,
      issues: seoIssuesFor(
        p.plan,
        plans.filter((o) => o.id !== p.id).map((o) => o.plan),
      ),
    }))
    .filter((s) => s.issues.length > 0);

  let customers: MerchantSnapshot["customers"] = { total: 0, repeatCount: 0, repeatPct: 0, avgLifetimeValue: 0 };
  let trafficBySource: MerchantSnapshot["trafficBySource"] = [];

  if (admin) {
    if (storeIds.length) {
      // Best-effort: these two tables may not exist yet if the migration
      // hasn't been applied — never let a missing table break the whole
      // snapshot, just degrade to "no customer/traffic data" like a
      // genuinely empty store would look.
      try {
        const { data: rows } = await admin
          .from("customers")
          .select("order_count, lifetime_value")
          .in("store_id", storeIds);
        const list = rows ?? [];
        const repeatCount = list.filter((c) => c.order_count > 1).length;
        customers = {
          total: list.length,
          repeatCount,
          repeatPct: list.length ? Math.round((repeatCount / list.length) * 100) : 0,
          avgLifetimeValue: list.length ? round2(list.reduce((s, c) => s + c.lifetime_value, 0) / list.length) : 0,
        };
      } catch {
        /* table not there yet — leave the zeroed default */
      }

      try {
        const since = new Date();
        since.setDate(since.getDate() - 30);
        const { data: events } = await admin
          .from("store_traffic_events")
          .select("source")
          .in("store_id", storeIds)
          .gte("created_at", since.toISOString());
        const list = events ?? [];
        if (list.length) {
          const bySource = new Map<string, number>();
          for (const e of list) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
          trafficBySource = [...bySource.entries()]
            .map(([source, count]) => ({ source, pct: Math.round((count / list.length) * 100) }))
            .sort((a, b) => b.pct - a.pct);
        }
      } catch {
        /* table not there yet */
      }
    }
  }

  const platformTopSellers = (await getPlatformTopSellers({ limit: 5 })).map((p) => ({
    name: p.title,
    category: p.category,
    unitsSold: p.unitsSold,
    marginPct: p.retail_price != null && p.wholesale_price != null
      ? Math.round(((p.retail_price - p.wholesale_price) / p.retail_price) * 100)
      : null,
  }));

  return {
    storeCount: storeList.length,
    liveStoreCount,
    storeNames: storeList.map((s) => s.name).filter((n): n is string => Boolean(n)),
    revenue: {
      net: rev.netRevenue,
      gross: rev.grossSales,
      orderCount: rev.orderCount,
      avgOrder: rev.avgOrder,
      units: rev.units,
    },
    revenueByStore,
    trend,
    storeStats,
    topProducts,
    walletBalance: rev.walletBalance,
    heldOrders: { count: rev.heldCount, value: rev.heldValue },
    pendingPayout: rev.pendingPayout,
    customers,
    trafficBySource,
    storeDesign,
    seoIssues,
    platformTopSellers,
  };
}

function trendLine(t: MerchantSnapshot["trend"]): string {
  const { last30, prior30 } = t;
  let movement: string;
  if (prior30.gross === 0 && last30.gross === 0) movement = "nothing sold in either window";
  else if (prior30.gross === 0) movement = "up from nothing in the prior window";
  else if (last30.gross === 0) movement = "down 100%";
  else {
    const pct = Math.round(((last30.gross - prior30.gross) / prior30.gross) * 100);
    movement = pct === 0 ? "flat" : pct > 0 ? `up ${pct}%` : `down ${Math.abs(pct)}%`;
  }
  return (
    `Last 30 days: $${last30.gross.toFixed(2)} gross across ${last30.orders} orders ` +
    `(prior 30 days: $${prior30.gross.toFixed(2)} across ${prior30.orders}) — ${movement}.`
  );
}

/** Compact plain-text digest for the EcomAI Co-Founder chat's system prompt. */
export function summarizeMerchantForAdvisor(s: MerchantSnapshot): string {
  const lines = [
    `Stores: ${s.storeCount} total (${s.liveStoreCount} live)${
      s.storeNames.length ? `: ${s.storeNames.join(", ")}` : ""
    }.`,
    `Revenue: $${s.revenue.net.toFixed(2)} realized/net — after supplier cost and the EcomStrait platform fee — ` +
      `across ${s.revenue.orderCount} orders ($${s.revenue.gross.toFixed(2)} gross checkout value, avg order $${s.revenue.avgOrder.toFixed(2)}, ${s.revenue.units} units sold). ` +
      `Net is what's actually kept; never call the gross figure "revenue."`,
    // Below: an empty string, not a "no X yet" sentence, whenever a
    // category has nothing — see SYSTEM_PROMPT in cofounder-ai.ts for why.
    // A co-founder who's actually IN the business doesn't narrate which
    // systems aren't built yet; feeding the model an explicit "No traffic
    // data yet" line was a real bug report — it kept opening replies with
    // "we're flying blind" instead of just working with what's here.
    s.revenueByStore.length
      ? `Revenue by store: ${s.revenueByStore.map((r) => `${r.name} $${r.total.toFixed(2)}`).join(", ")}.`
      : "",
    // Trend line only once there's ever been an order — a store with no
    // checkouts at all is already covered by the "across 0 orders" above,
    // and an all-zero comparison would just be an empty category narrated.
    s.revenue.orderCount > 0 ? trendLine(s.trend) : "",
    s.storeStats.length
      ? `Per store: ${s.storeStats
          .map(
            (st) =>
              `${st.name} — ${st.orders} order${st.orders === 1 ? "" : "s"}${st.orders ? `, avg order $${st.avgOrder.toFixed(2)}` : ""}, ${
                st.launchedDaysAgo == null
                  ? "still a draft (not launched)"
                  : st.launchedDaysAgo === 0
                    ? "launched today"
                    : `launched ${st.launchedDaysAgo} day${st.launchedDaysAgo === 1 ? "" : "s"} ago`
              }`,
          )
          .join("; ")}.`
      : "",
    s.topProducts.length
      ? `Top products by revenue: ${s.topProducts
          .slice(0, 3)
          .map((p) => `${p.name} ($${p.revenue.toFixed(2)}, ${p.units} units)`)
          .join("; ")}.`
      : "",
    `Wallet balance: $${s.walletBalance.toFixed(2)}.`,
    s.heldOrders.count > 0
      ? `${s.heldOrders.count} order(s) worth $${s.heldOrders.value.toFixed(2)} are on hold, not yet sent to suppliers because the wallet balance doesn't cover them.`
      : `No orders currently blocked by low wallet credits.`,
    s.pendingPayout > 0
      ? `$${s.pendingPayout.toFixed(2)} is owed to this merchant by EcomStrait (COD orders' margin), pending the next weekly settlement.`
      : "",
    s.customers.total > 0
      ? `Customers (estimated): ${s.customers.total} total, ${s.customers.repeatCount} repeat (${s.customers.repeatPct}%), avg lifetime value $${s.customers.avgLifetimeValue.toFixed(2)}.`
      : "",
    s.trafficBySource.length
      ? `Traffic mix (estimated, last 30 days): ${s.trafficBySource.map((t) => `${t.source.replace("_", " ")} ${t.pct}%`).join(", ")}.`
      : "",
    s.storeDesign.length
      ? `Store design: ${s.storeDesign.map((d) => `${d.name} — ${d.theme ?? "no theme set"}, colors ${d.brandColors.join("/") || "default"}`).join("; ")}.`
      : "",
    // "Basic checks" and not "SEO gaps" deliberately — these are cheap
    // heuristics on the plan's own text fields (see `seoIssuesFor`), not a
    // real audit (no keyword research, backlinks, page speed, product or blog
    // pages). Said that plainly so a confident answer built on this doesn't
    // overstate a crude proxy as the definitive finding.
    s.seoIssues.length
      ? `Basic SEO checks (length, keyword presence, CTA, duplicates across your stores — not a full audit): ${s.seoIssues.map((i) => `${i.storeName}: ${i.issues.join("; ")}`).join(" | ")}.`
      : `Basic SEO checks (length, keyword presence, CTA, duplicates across your stores — not a full audit) found nothing thin.`,
    s.platformTopSellers.length
      ? `What's selling well across the platform right now (market context, not this merchant's own sales): ${s.platformTopSellers
          .map((p) => `${p.name}${p.category ? ` (${p.category})` : ""} — ${p.unitsSold} units${p.marginPct != null ? `, ~${p.marginPct}% margin` : ""}`)
          .join("; ")}.`
      : "",
  ].filter(Boolean);
  return lines.join("\n");
}

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@ecomstrait/db/types";
import { createAdminClient } from "@ecomstrait/db/admin";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

const TREND_DAYS = 14;

export type MerchantRevenueAnalytics = {
  /** Net revenue actually realized — sum of (margin − platform fee) across
   *  every supplier-order slice that's been deducted/settled internally
   *  (`orders.credit_status = 'deducted'`). This is what a merchant actually
   *  keeps once the supplier's cost and EcomStrait's fee are accounted for —
   *  see Docs/Credits-Settlement-Plan.md. Requires the admin client (`orders`
   *  has no merchant-facing RLS); degrades to 0 without one rather than
   *  guessing at a number. */
  netRevenue: number;
  /** Gross checkout value across every order, regardless of settlement —
   *  what customers paid, not what the merchant keeps. */
  grossSales: number;
  orderCount: number;
  avgOrder: number;
  units: number;
  /** Gross, by store — same basis as `grossSales`. */
  revenueByStore: { name: string; total: number }[];
  /** Gross, last 14 days — same basis as `grossSales`. */
  revenueByDay: { label: string; total: number }[];
  /** Gross, by product line item — a "what's selling" mix, not a "what you keep" one. */
  topProducts: { name: string; units: number; revenue: number }[];
  /** Orders still blocked on this merchant's own low wallet balance — not
   *  counted in `netRevenue` until a top-up releases them. */
  heldValue: number;
  heldCount: number;
  /** What EcomStrait owes this merchant (COD orders' margin) that hasn't
   *  been paid out in a settlement batch yet — Docs/Credits-Settlement-Plan.md §4. */
  pendingPayout: number;
  walletBalance: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Revenue analytics for a merchant, across all their stores — the merchant
 * counterpart to the supplier app's `getSupplierRevenueAnalytics`. Shared
 * between the Sales page and the Co-Founder snapshot so both quote the same
 * numbers, computed the same way, instead of the Sales page and the AI
 * silently disagreeing.
 *
 * Two different tables answer two different questions, and this deliberately
 * keeps them separate rather than papering over the gap:
 *  - `store_orders` (gross, ops-facing): every checkout, at the amount the
 *    customer paid, regardless of internal settlement — "how much came
 *    through, how many orders, what's selling."
 *  - `orders` (net, money-facing): the per-supplier slice of each checkout
 *    the wallet/settlement system has actually finalized
 *    (`credit_status = 'deducted'`) — "what you actually keep." A COD
 *    order's full subtotal is cash the supplier keeps, not the merchant, and
 *    an order still on hold (low wallet balance) hasn't been finalized at
 *    all — neither belongs in a merchant-facing "revenue" figure at face
 *    value, which is exactly the bug this replaces (the old Sales page and
 *    Co-Founder snapshot both summed `store_orders.subtotal` unconditionally
 *    and called it "Revenue").
 */
export async function getMerchantRevenueAnalytics(
  supabase: SupabaseClient<Database>,
  admin: Admin | null,
  userId: string,
  storeIds: string[],
  storeName: Map<string, string>,
): Promise<MerchantRevenueAnalytics> {
  const { data: storeOrders } = storeIds.length
    ? await supabase
        .from("store_orders")
        .select("store_id, subtotal, items, created_at")
        .in("store_id", storeIds)
    : { data: [] };
  // `store_orders.status` is only ever written as "paid" at insert time and
  // never updated anywhere else (see orders/page.tsx's comment) — every row
  // here is already a paid checkout, so no further status filter applies.
  const all = storeOrders ?? [];

  const grossSales = all.reduce((s, o) => s + (o.subtotal ?? 0), 0);
  const orderCount = all.length;
  const units = all.reduce((s, o) => s + (o.items ?? []).reduce((n, i) => n + i.quantity, 0), 0);

  const byStore = new Map<string, number>();
  for (const o of all) byStore.set(o.store_id, (byStore.get(o.store_id) ?? 0) + (o.subtotal ?? 0));
  const revenueByStore = [...byStore.entries()]
    .map(([id, total]) => ({ name: storeName.get(id) ?? "—", total: round2(total) }))
    .sort((a, b) => b.total - a.total);

  const byProduct = new Map<string, { units: number; revenue: number }>();
  for (const o of all) {
    for (const i of o.items ?? []) {
      const cur = byProduct.get(i.name) ?? { units: 0, revenue: 0 };
      cur.units += i.quantity;
      cur.revenue += (i.unit_price ?? 0) * i.quantity;
      byProduct.set(i.name, cur);
    }
  }
  const topProducts = [...byProduct.entries()]
    .map(([name, v]) => ({ name, units: v.units, revenue: round2(v.revenue) }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 6);

  // ---- Gross trend, last 14 days ----
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buckets = new Map<string, number>();
  const labels: string[] = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    buckets.set(label, 0);
    labels.push(label);
  }
  for (const o of all) {
    const label = new Date(o.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    if (buckets.has(label)) buckets.set(label, (buckets.get(label) ?? 0) + (o.subtotal ?? 0));
  }
  const revenueByDay = labels.map((label) => ({ label, total: round2(buckets.get(label) ?? 0) }));

  // ---- Net/realized figures — admin-only (see type doc above) ----
  let netRevenue = 0;
  let heldValue = 0;
  let heldCount = 0;
  let pendingPayout = 0;
  let walletBalance = 0;
  if (admin) {
    const { data: wallet } = await admin
      .from("merchant_wallets")
      .select("balance")
      .eq("user_id", userId)
      .maybeSingle();
    walletBalance = wallet?.balance ?? 0;

    if (storeIds.length) {
      const [{ data: realized }, { data: held }, { data: payable }] = await Promise.all([
        admin
          .from("orders")
          .select("margin_amount, platform_fee_amount")
          .in("store_id", storeIds)
          .eq("credit_status", "deducted"),
        admin
          .from("orders")
          .select("cost_amount, platform_fee_amount")
          .in("store_id", storeIds)
          .eq("credit_status", "awaiting_merchant_credits"),
        admin
          .from("payable_ledger")
          .select("amount")
          .eq("account_type", "merchant")
          .eq("account_id", userId)
          .eq("status", "pending"),
      ]);
      netRevenue = round2(
        (realized ?? []).reduce((s, o) => s + (o.margin_amount ?? 0) - (o.platform_fee_amount ?? 0), 0),
      );
      heldValue = round2((held ?? []).reduce((s, o) => s + (o.cost_amount ?? 0) + (o.platform_fee_amount ?? 0), 0));
      heldCount = held?.length ?? 0;
      pendingPayout = round2((payable ?? []).reduce((s, p) => s + p.amount, 0));
    }
  }

  return {
    netRevenue,
    grossSales: round2(grossSales),
    orderCount,
    avgOrder: round2(orderCount ? grossSales / orderCount : 0),
    units,
    revenueByStore,
    revenueByDay,
    topProducts,
    heldValue,
    heldCount,
    pendingPayout,
    walletBalance,
  };
}

const WINDOW_DAYS = 30;

/** Gross-basis trend + per-store order stats — see `getMerchantOrderTrend`. */
export type MerchantOrderTrend = {
  /** Gross checkout value + checkout count, last 30 days (today back 30 days). */
  last30: { gross: number; orders: number };
  /** Same, for the 30 days before that (days 31–60 ago). */
  prior30: { gross: number; orders: number };
  /** All-time per-store checkout count and average order value (gross basis). */
  perStore: { storeId: string; name: string; orders: number; gross: number; avgOrder: number }[];
};

/**
 * The time dimension the Co-Founder snapshot was missing (2026-09-07
 * capability audit, T7): last-30-days vs prior-30-days gross sales and order
 * count, plus per-store order count / AOV. Same `store_orders` gross basis
 * as `getMerchantRevenueAnalytics` — one checkout per row, at what the
 * customer paid — never net; `cancelled` checkouts are excluded per the
 * shared metric definitions (`@ecomstrait/ai`'s METRIC_DEFINITIONS).
 *
 * Deliberately a separate helper rather than more fields on
 * `MerchantRevenueAnalytics`, so the Sales page's existing numbers are
 * untouched.
 */
export async function getMerchantOrderTrend(
  supabase: SupabaseClient<Database>,
  storeIds: string[],
  storeName: Map<string, string>,
): Promise<MerchantOrderTrend> {
  const empty = { gross: 0, orders: 0 };
  if (!storeIds.length) return { last30: { ...empty }, prior30: { ...empty }, perStore: [] };

  const { data } = await supabase
    .from("store_orders")
    .select("store_id, subtotal, created_at, status")
    .in("store_id", storeIds)
    .neq("status", "cancelled");
  const all = data ?? [];

  const now = Date.now();
  const last30Start = now - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const prior30Start = last30Start - WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const last30 = { ...empty };
  const prior30 = { ...empty };
  const byStore = new Map<string, { orders: number; gross: number }>();
  for (const o of all) {
    const t = new Date(o.created_at).getTime();
    const amount = o.subtotal ?? 0;
    if (t >= last30Start) {
      last30.orders += 1;
      last30.gross += amount;
    } else if (t >= prior30Start) {
      prior30.orders += 1;
      prior30.gross += amount;
    }
    const cur = byStore.get(o.store_id) ?? { orders: 0, gross: 0 };
    cur.orders += 1;
    cur.gross += amount;
    byStore.set(o.store_id, cur);
  }

  const perStore = storeIds.map((id) => {
    const v = byStore.get(id) ?? { orders: 0, gross: 0 };
    return {
      storeId: id,
      name: storeName.get(id) ?? "—",
      orders: v.orders,
      gross: round2(v.gross),
      avgOrder: round2(v.orders ? v.gross / v.orders : 0),
    };
  });

  return {
    last30: { gross: round2(last30.gross), orders: last30.orders },
    prior30: { gross: round2(prior30.gross), orders: prior30.orders },
    perStore,
  };
}

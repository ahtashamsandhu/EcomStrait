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

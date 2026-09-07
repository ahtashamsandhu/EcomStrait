import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, OrderStatus, OrderPaymentType } from "@ecomstrait/db/types";

const TREND_DAYS = 14;

export type SupplierRevenueAnalytics = {
  /** All-time revenue (sum of `cost_amount` on realized orders) — the
   *  supplier's actual take on a sale, prepaid or COD (see note below). */
  totalRevenue: number;
  orderCount: number;
  revenueByDay: { date: string; amount: number }[];
  statusCounts: { status: OrderStatus; count: number }[];
  paymentMix: { type: OrderPaymentType; count: number; amount: number }[];
  /** Value stuck behind low wallet credits — not yet released to the
   *  supplier's own orders queue (Docs/Credits-Settlement-Plan.md). */
  heldValue: number;
  heldCount: number;
  walletBalance: number;
  topProducts: { name: string; units: number; revenue: number }[];
  /** Same realized/`deducted` basis as `totalRevenue`, windowed: the last 30
   *  days vs the 30 before that — the trend the all-time totals above can't
   *  show (2026-09-07 capability audit, T7/§10.1). Window edges are
   *  `created_at`-based, UTC. */
  recent: {
    last30: { revenue: number; orders: number };
    prior30: { revenue: number; orders: number };
  };
  /** Order ageing for the realized `processing` queue — how many have sat
   *  unshipped past 3 / 7 days, and the oldest one, so the Co-Founder chat
   *  can name the slow order it's told to lead with (§10.5). */
  ageing: {
    processingOver3Days: number;
    processingOver7Days: number;
    /** `orders.number` of the oldest still-processing order, or null. */
    oldestProcessingNumber: number | null;
    oldestProcessingAgeDays: number | null;
  };
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const DAY_MS = 86_400_000;

/** Percentage change from `prior` to `current`; null when prior is 0 (no meaningful base). */
export function pctChange(current: number, prior: number): number | null {
  if (prior <= 0) return null;
  return Math.round(((current - prior) / prior) * 100);
}

/**
 * Revenue/order analytics for a supplier — the counterpart to
 * `getSupplierAnalytics` (catalog/requests/quality) that this app never had:
 * before this, Analytics never queried `orders`, `order_items`, or
 * `supplier_wallets` at all.
 *
 * Only counts orders with `credit_status = 'deducted'` (mirrors the filter
 * the orders list itself already applies, `orders/page.tsx`) — an order
 * still `awaiting_supplier_credits` hasn't actually been paid out and must
 * never inflate a revenue number a supplier could act on.
 *
 * `cost_amount` is used as "revenue" for both payment types: on a prepaid
 * order it's what the merchant owes the supplier; on a COD order the
 * supplier collects the full subtotal in cash but has already had
 * `margin_amount + platform_fee_amount` deducted from their wallet up
 * front, so `cost_amount` (= subtotal - margin) is what they actually keep
 * either way — one consistent metric across both payment types.
 */
export async function getSupplierRevenueAnalytics(
  supabase: SupabaseClient<Database>,
  supplierId: string,
): Promise<SupplierRevenueAnalytics> {
  const [{ data: orders }, { data: heldOrders }, { data: wallet }] = await Promise.all([
    supabase
      .from("orders")
      .select("id, number, status, payment_type, cost_amount, margin_amount, platform_fee_amount, created_at")
      .eq("supplier_id", supplierId)
      .eq("credit_status", "deducted"),
    supabase
      .from("orders")
      .select("id, margin_amount, platform_fee_amount")
      .eq("supplier_id", supplierId)
      .eq("credit_status", "awaiting_supplier_credits"),
    supabase.from("supplier_wallets").select("balance").eq("supplier_id", supplierId).maybeSingle(),
  ]);

  const realized = orders ?? [];
  const held = heldOrders ?? [];

  const totalRevenue = realized.reduce((s, o) => s + (o.cost_amount ?? 0), 0);

  // ---- Revenue trend (last 14 days) ----
  const now = new Date();
  const buckets = new Map<string, number>();
  for (let d = TREND_DAYS - 1; d >= 0; d--) {
    const dt = new Date(now);
    dt.setDate(now.getDate() - d);
    buckets.set(dt.toISOString().slice(0, 10), 0);
  }
  for (const o of realized) {
    const key = o.created_at.slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + (o.cost_amount ?? 0));
  }
  const revenueByDay = [...buckets.entries()].map(([date, amount]) => ({ date, amount: round2(amount) }));

  // ---- Last 30 days vs the 30 before (same realized basis as totalRevenue) ----
  const nowMs = now.getTime();
  const last30Start = nowMs - 30 * DAY_MS;
  const prior30Start = nowMs - 60 * DAY_MS;
  const sumWindow = (fromMs: number, toMs: number) => {
    const rows = realized.filter((o) => {
      const t = new Date(o.created_at).getTime();
      return t >= fromMs && t < toMs;
    });
    return { revenue: round2(rows.reduce((s, o) => s + (o.cost_amount ?? 0), 0)), orders: rows.length };
  };
  const recent = { last30: sumWindow(last30Start, nowMs + 1), prior30: sumWindow(prior30Start, last30Start) };

  // ---- Order ageing (processing queue) ----
  let processingOver3Days = 0;
  let processingOver7Days = 0;
  let oldest: { number: number; ageDays: number } | null = null;
  for (const o of realized) {
    if (o.status !== "processing") continue;
    const ageDays = (nowMs - new Date(o.created_at).getTime()) / DAY_MS;
    if (ageDays > 3) processingOver3Days += 1;
    if (ageDays > 7) processingOver7Days += 1;
    if (!oldest || ageDays > oldest.ageDays) oldest = { number: o.number, ageDays };
  }
  const ageing = {
    processingOver3Days,
    processingOver7Days,
    oldestProcessingNumber: oldest?.number ?? null,
    oldestProcessingAgeDays: oldest ? Math.floor(oldest.ageDays) : null,
  };

  // ---- Status breakdown ----
  const statusOrder: OrderStatus[] = ["processing", "shipped", "delivered", "cancelled"];
  const statusCounts = statusOrder.map((status) => ({
    status,
    count: realized.filter((o) => o.status === status).length,
  }));

  // ---- COD vs prepaid mix ----
  const paymentTypes: OrderPaymentType[] = ["prepaid", "cod"];
  const paymentMix = paymentTypes.map((type) => {
    const rows = realized.filter((o) => o.payment_type === type);
    return { type, count: rows.length, amount: round2(rows.reduce((s, o) => s + (o.cost_amount ?? 0), 0)) };
  });

  const heldValue = round2(held.reduce((s, o) => s + (o.margin_amount ?? 0) + (o.platform_fee_amount ?? 0), 0));

  // ---- Top products by revenue ----
  const orderIds = realized.map((o) => o.id);
  const { data: items } = orderIds.length
    ? await supabase.from("order_items").select("product_name, quantity, unit_price").in("order_id", orderIds)
    : { data: [] };
  const byProduct = new Map<string, { units: number; revenue: number }>();
  for (const it of items ?? []) {
    const cur = byProduct.get(it.product_name) ?? { units: 0, revenue: 0 };
    cur.units += it.quantity;
    cur.revenue += (it.unit_price ?? 0) * it.quantity;
    byProduct.set(it.product_name, cur);
  }
  const topProducts = [...byProduct.entries()]
    .map(([name, v]) => ({ name, units: v.units, revenue: round2(v.revenue) }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 6);

  return {
    totalRevenue: round2(totalRevenue),
    orderCount: realized.length,
    revenueByDay,
    statusCounts,
    paymentMix,
    heldValue,
    heldCount: held.length,
    walletBalance: wallet?.balance ?? 0,
    topProducts,
    recent,
    ageing,
  };
}

/** Compact plain-text digest for the EcomAI Co-Founder chat's system prompt —
 *  keeps the advisor grounded in real numbers without re-querying anything. */
export function summarizeForAdvisor(a: SupplierRevenueAnalytics): string {
  const { last30, prior30 } = a.recent;
  const change = pctChange(last30.revenue, prior30.revenue);
  const trendLine =
    last30.orders === 0 && prior30.orders === 0
      ? `Last 30 days: no realized orders (none in the 30 days before either).`
      : `Last 30 days: $${last30.revenue.toFixed(2)} across ${last30.orders} order(s); prior 30 days: $${prior30.revenue.toFixed(2)} across ${prior30.orders} order(s)${
          change != null ? ` (${change >= 0 ? "+" : ""}${change}% revenue)` : ""
        }.`;
  const ag = a.ageing;
  const ageingLine =
    ag.oldestProcessingNumber == null
      ? `Order ageing: nothing sitting in processing.`
      : ag.processingOver3Days === 0
        ? `Order ageing: all processing orders are under 3 days old (oldest is #${ag.oldestProcessingNumber}, ${ag.oldestProcessingAgeDays} day(s)).`
        : `Order ageing: ${ag.processingOver3Days} processing order(s) older than 3 days, ${ag.processingOver7Days} older than 7 days; oldest is order #${ag.oldestProcessingNumber} (${ag.oldestProcessingAgeDays} days unshipped).`;
  const lines = [
    `Revenue (all-time, realized/paid orders only): $${a.totalRevenue.toFixed(2)} across ${a.orderCount} orders.`,
    trendLine,
    `Order status: ${a.statusCounts.map((s) => `${s.status} ${s.count}`).join(", ")}.`,
    ageingLine,
    `Payment mix: ${a.paymentMix.map((p) => `${p.type} ${p.count} orders ($${p.amount.toFixed(2)})`).join(", ")}.`,
    a.heldCount > 0
      ? `${a.heldCount} order(s) worth $${a.heldValue.toFixed(2)} are currently on hold, blocked by low wallet credits.`
      : `No orders currently blocked by low credits.`,
    `Wallet balance: $${a.walletBalance.toFixed(2)}.`,
    a.topProducts.length
      ? `Top products by revenue: ${a.topProducts
          .slice(0, 3)
          .map((p) => `${p.name} ($${p.revenue.toFixed(2)}, ${p.units} units)`)
          .join("; ")}.`
      : `No product sales data yet.`,
  ];
  return lines.join("\n");
}

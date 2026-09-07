import type { Metadata } from "next";
import Link from "next/link";
import { ShoppingBag, Wallet } from "lucide-react";
import { createClient } from "@ecomstrait/auth/server";
import { createAdminClient } from "@ecomstrait/db/admin";
import type { OrderStatus } from "@ecomstrait/db/types";

export const metadata: Metadata = { title: "Orders" };

// Payment status — `store_orders.status` is only ever written as "paid" (the
// row is created straight from a successful Stripe session, see
// storefront-orders.ts / order-sink.ts), but this stays a lookup rather than
// a literal so a future refund/cancellation flow has somewhere to plug in.
const PAYMENT_STYLE: Record<string, string> = {
  paid: "bg-brand-50 text-brand-700",
  refunded: "bg-ink-100 text-ink-500",
  cancelled: "bg-ink-100 text-ink-400",
};
const PAYMENT_LABEL: Record<string, string> = {
  paid: "Paid",
  refunded: "Refunded",
  cancelled: "Cancelled",
};

// Fulfilment status — the supplier-facing lifecycle, from the linked
// `orders` row(s). Same palette language as the supplier app's own
// ORDER_STATUS_STYLE (apps/supplier/src/lib/order-status.ts) so the color
// means the same thing on both sides of the platform.
const FULFILMENT_STYLE: Record<OrderStatus, string> = {
  processing: "bg-ai-50 text-ai-700",
  shipped: "bg-amber-50 text-amber-700",
  delivered: "bg-brand-50 text-brand-700",
  cancelled: "bg-ink-100 text-ink-400",
};
const FULFILMENT_LABEL: Record<OrderStatus, string> = {
  processing: "Processing",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};
const HELD_STYLE = "bg-red-50 text-red-600";

/**
 * Collapse one store order's linked supplier orders (one per supplier
 * involved in that checkout — see order-sink.ts's `bySupplier` grouping)
 * into a single status a merchant can glance at: still in progress
 * anywhere it counts as not shipped yet, and it isn't "delivered" until
 * every last one of them is.
 */
function aggregateFulfilment(statuses: OrderStatus[]): OrderStatus | null {
  if (statuses.length === 0) return null;
  const active = statuses.filter((s) => s !== "cancelled");
  if (active.length === 0) return "cancelled";
  if (active.includes("processing")) return "processing";
  if (active.includes("shipped")) return "shipped";
  return "delivered";
}

function money(n: number | null): string {
  return `$${(n ?? 0).toFixed(2)}`;
}
function when(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function OrdersPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: stores } = await supabase.from("stores").select("id, name").eq("user_id", user!.id);
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name]));
  const storeIds = (stores ?? []).map((s) => s.id);
  const { data: orders } = storeIds.length
    ? await supabase
        .from("store_orders")
        .select("id, store_id, customer_name, customer_email, subtotal, items, status, created_at")
        .in("store_id", storeIds)
        .order("created_at", { ascending: false })
    : { data: [] };
  const list = orders ?? [];

  // Fulfilment status + held-for-credits flag both live on the linked
  // supplier-facing `orders` rows, which have no merchant RLS — read via the
  // admin client, same pattern as before, just no longer filtered down to
  // held rows only.
  const admin = createAdminClient();
  const storeOrderIds = list.map((o) => o.id);
  const fulfilmentByStoreOrder = new Map<string, OrderStatus>();
  const heldStoreOrderIds = new Set<string>();
  if (admin && storeOrderIds.length) {
    const { data: linked } = await admin
      .from("orders")
      .select("store_order_id, status, credit_status")
      .in("store_order_id", storeOrderIds);
    const byStoreOrder = new Map<string, OrderStatus[]>();
    for (const row of linked ?? []) {
      if (!row.store_order_id) continue;
      const arr = byStoreOrder.get(row.store_order_id) ?? [];
      arr.push(row.status);
      byStoreOrder.set(row.store_order_id, arr);
      if (row.credit_status === "awaiting_merchant_credits") heldStoreOrderIds.add(row.store_order_id);
    }
    for (const [storeOrderId, statuses] of byStoreOrder) {
      const status = aggregateFulfilment(statuses);
      if (status) fulfilmentByStoreOrder.set(storeOrderId, status);
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-ink-950">Orders</h1>
        <p className="mt-1 text-sm text-ink-500">Customer orders across your stores, routed to suppliers for fulfilment.</p>
      </div>
      <div className="mt-6">
        {list.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-ink-200 bg-ink-50/40 px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-ink-300 shadow-sm ring-1 ring-ink-100">
              <ShoppingBag className="h-5 w-5" />
            </div>
            <p className="font-semibold text-ink-800">No orders yet</p>
            <p className="max-w-sm text-sm text-ink-500">Once a customer checks out on one of your stores, it&rsquo;ll show up here.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-sm shadow-ink-950/[0.02]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b border-ink-100 bg-ink-50/60 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                    <th className="px-5 py-3">Order</th>
                    <th className="hidden px-4 py-3 sm:table-cell">Store</th>
                    <th className="hidden px-4 py-3 md:table-cell">Customer</th>
                    <th className="px-4 py-3">Items</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3 text-right">Payment</th>
                    <th className="px-5 py-3 text-right">Fulfilment</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((o) => {
                    const items = o.items ?? [];
                    const units = items.reduce((s, i) => s + i.quantity, 0);
                    const summary = items.map((i) => `${i.name} ×${i.quantity}`).join(", ");
                    const held = heldStoreOrderIds.has(o.id);
                    const fulfilment = fulfilmentByStoreOrder.get(o.id);
                    return (
                      <tr key={o.id} className={`border-b border-ink-50 align-top transition last:border-0 hover:bg-ink-50/40 ${held ? "bg-red-50/30" : ""}`}>
                        <td className="px-5 py-4">
                          <p className={`font-semibold ${held ? "text-red-700" : "text-ink-900"}`}>#{o.id.slice(0, 8)}</p>
                          <p className="text-xs text-ink-400">{when(o.created_at)}</p>
                          {held && (
                            <Link
                              href="/wallet"
                              className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-1 text-[11px] font-semibold text-red-700 transition hover:bg-red-200"
                            >
                              <Wallet className="h-3 w-3" />
                              Waiting on wallet balance — add funds
                            </Link>
                          )}
                        </td>
                        <td className="hidden px-4 py-4 text-ink-600 sm:table-cell">{storeName.get(o.store_id) ?? "—"}</td>
                        <td className="hidden px-4 py-4 md:table-cell">
                          <p className="text-ink-700">{o.customer_name ?? "—"}</p>
                          <p className="text-xs text-ink-400">{o.customer_email ?? ""}</p>
                        </td>
                        <td className="px-4 py-4">
                          <p className="text-ink-700">
                            {units} unit{units === 1 ? "" : "s"}
                          </p>
                          <p className="max-w-[16rem] truncate text-xs text-ink-400" title={summary}>
                            {summary}
                          </p>
                        </td>
                        <td className="px-4 py-4 text-right font-semibold text-ink-900">{money(o.subtotal)}</td>
                        <td className="px-4 py-4 text-right">
                          <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${PAYMENT_STYLE[o.status] ?? "bg-ink-100 text-ink-500"}`}>
                            {PAYMENT_LABEL[o.status] ?? o.status}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-right">
                          {held ? (
                            <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${HELD_STYLE}`}>On hold</span>
                          ) : fulfilment ? (
                            <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${FULFILMENT_STYLE[fulfilment]}`}>
                              {FULFILMENT_LABEL[fulfilment]}
                            </span>
                          ) : (
                            <span className="inline-flex rounded-full bg-ink-100 px-2.5 py-1 text-xs font-semibold text-ink-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

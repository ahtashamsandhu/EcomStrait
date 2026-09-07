import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, SupplierStatus } from "@ecomstrait/db/types";

export type Notification = { id: string; title: string; body: string; href: string };

/**
 * Actionable, derived notifications — no separate table. Reflects the things a
 * supplier should act on right now (onboarding, open requests, low stock).
 */
export async function getNotifications(
  supabase: SupabaseClient<Database>,
  supplier: { id: string; status: SupplierStatus } | null,
): Promise<Notification[]> {
  const items: Notification[] = [];

  if (!supplier) {
    return [
      { id: "onboard", title: "Finish onboarding", body: "Set up your supplier profile to get verified.", href: "/onboarding" },
    ];
  }

  if (supplier.status === "pending") {
    items.push({ id: "onboard", title: "Finish onboarding", body: "Complete onboarding to get verified.", href: "/onboarding" });
  } else if (supplier.status === "in_review") {
    items.push({ id: "review", title: "Application under review", body: "We're verifying your business.", href: "/dashboard" });
  } else if (supplier.status === "rejected") {
    items.push({ id: "rejected", title: "Verification needs attention", body: "Please review your details.", href: "/dashboard" });
  }

  if (supplier.status === "approved") {
    const { count: openReq } = await supabase
      .from("product_requests")
      .select("id", { count: "exact", head: true })
      .eq("supplier_id", supplier.id)
      .in("status", ["new", "proposed"]);
    if (openReq && openReq > 0) {
      items.push({
        id: "requests",
        title: `${openReq} request${openReq === 1 ? "" : "s"} need a response`,
        body: "Open your requests inbox.",
        href: "/requests",
      });
    }

    // Same visibility rule as /orders: an order only counts once its wallet
    // charge has actually gone through. A held one (the merchant had no
    // credits to place it, or the supplier's own wallet can't cover a COD
    // deduction) isn't something the supplier can act on yet, so nudging
    // them to "fulfil" it would be a dead end.
    const { count: openOrders } = await supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("supplier_id", supplier.id)
      .eq("credit_status", "deducted")
      .in("status", ["processing", "shipped"]);
    if (openOrders && openOrders > 0) {
      items.push({
        id: "orders",
        title: `${openOrders} order${openOrders === 1 ? "" : "s"} to fulfil`,
        body: "Update fulfilment status.",
        href: "/orders",
      });
    }

    const { data: prods } = await supabase
      .from("products")
      .select("stock, reserved, low_stock_threshold")
      .eq("supplier_id", supplier.id);
    const lowCount = (prods ?? []).filter(
      (p) => p.stock - p.reserved <= p.low_stock_threshold,
    ).length;
    if (lowCount > 0) {
      items.push({
        id: "lowstock",
        title: `${lowCount} product${lowCount === 1 ? "" : "s"} low on stock`,
        body: "Restock to keep selling.",
        href: "/inventory",
      });
    }
  }

  return items;
}

"use server";

import { revalidatePath } from "next/cache";
import type { OrderStatus } from "@ecomstrait/db/types";
import { getSupplierContext } from "@/lib/supplier-context";
import { sendStoreOwnerEmail, escapeHtml } from "@/lib/notify";
import { ORDER_STATUS_TRANSITIONS } from "@/lib/order-status";
import { friendlyError } from "@/lib/errors";

/** Advance an order through its fulfilment lifecycle (and email the customer). */
export async function setOrderStatus(
  orderId: string,
  status: OrderStatus,
): Promise<{ error?: string }> {
  const ctx = await getSupplierContext();
  if ("error" in ctx) return ctx;

  const { data: order } = await ctx.supabase
    .from("orders")
    .select("id, number, customer_email, status")
    .eq("id", orderId)
    .eq("supplier_id", ctx.supplierId)
    .maybeSingle();
  if (!order) return { error: "Order not found." };

  // The lifecycle is enforced here and again by a trigger in the database.
  // Without it a delivered COD order could be "cancelled" after the cash was
  // collected, refunding the up-front deduction.
  const allowed = (ORDER_STATUS_TRANSITIONS[order.status] ?? []).some((t) => t.to === status);
  if (!allowed) return { error: `An order that is ${order.status} can't be marked ${status}.` };

  const { error } = await ctx.supabase
    .from("orders")
    .update({ status })
    .eq("id", orderId)
    .eq("supplier_id", ctx.supplierId);
  if (error) return { error: friendlyError(error) };

  // Docs/Credits-Settlement-Plan.md: a COD order's margin+fee was already
  // deducted from this supplier's wallet up front. If it never delivers,
  // reverse that — a no-op for anything not an already-deducted COD order,
  // so this is safe to call on every cancellation unconditionally. The
  // function refunds what the ledger says was taken, never what the order
  // row claims.
  if (status === "cancelled") {
    const { error: reverseError } = await ctx.supabase.rpc("reverse_cod_deduction", { p_order_id: orderId });
    if (reverseError) {
      console.error("[orders] COD reversal failed for", orderId, reverseError);
      return { error: "The order was cancelled, but the wallet refund didn't go through. Support has been notified." };
    }
  }

  if (order.customer_email) {
    await sendStoreOwnerEmail({
      to: order.customer_email,
      subject: `Order #${order.number} is ${status}`,
      html: `<p>Your order <strong>#${order.number}</strong> is now <strong>${escapeHtml(status)}</strong>.</p>`,
    });
  }

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  return {};
}

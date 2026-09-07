"use server";

import { revalidatePath } from "next/cache";
import type { RequestStatus } from "@ecomstrait/db/types";
import { createClient } from "@ecomstrait/auth/server";
import { getSupplierContext } from "@/lib/supplier-context";
import { friendlyError } from "@/lib/errors";
import { sendStoreOwnerEmail, escapeHtml } from "@/lib/notify";

type Sb = Awaited<ReturnType<typeof createClient>>;

const REQUEST_STATUSES = new Set<string>(["new", "accepted", "declined", "proposed", "fulfilled"]);
/** Mirrors the CHECK on request_messages.body. */
const MAX_MESSAGE = 10_000;

/** Create an Order from an accepted request, copying store info + line items. */
async function createOrderFromRequest(
  supabase: Sb,
  supplierId: string,
  requestId: string,
  req: { store_name: string | null; store_owner_name: string | null; store_owner_email: string | null },
) {
  const { data: existing } = await supabase
    .from("orders")
    .select("id")
    .eq("request_id", requestId)
    .maybeSingle();
  if (existing) return;

  const { data: order } = await supabase
    .from("orders")
    .insert({
      supplier_id: supplierId,
      request_id: requestId,
      store_name: req.store_name,
      // `orders.customer_name/email` is who the shipment goes to — for a
      // request-originated order that's the requesting merchant themselves
      // (no separate end-customer exists in this flow), unlike a
      // sale-originated order (order-sink.ts) where it's the actual buyer.
      customer_name: req.store_owner_name,
      customer_email: req.store_owner_email,
      status: "processing",
    })
    .select("id")
    .single();
  if (!order) return;

  const { data: items } = await supabase
    .from("request_items")
    .select("product_id, product_name, quantity")
    .eq("request_id", requestId);

  const rows = (items ?? []).map((it) => ({
    order_id: order.id,
    product_id: it.product_id,
    product_name: it.product_name,
    quantity: it.quantity,
    unit_price: null as number | null,
  }));

  const productIds = rows.map((r) => r.product_id).filter(Boolean) as string[];
  if (productIds.length) {
    const { data: prods } = await supabase
      .from("products")
      .select("id, retail_price")
      .in("id", productIds);
    const priceMap = new Map((prods ?? []).map((p) => [p.id, p.retail_price]));
    for (const r of rows) if (r.product_id) r.unit_price = priceMap.get(r.product_id) ?? null;
  }

  if (rows.length) await supabase.from("order_items").insert(rows);
  revalidatePath("/orders");
}

/** Update a request's status, log a system note, optionally add a reply + email. */
export async function setRequestStatus(
  requestId: string,
  status: RequestStatus,
  options?: { message?: string },
): Promise<{ error?: string }> {
  const ctx = await getSupplierContext();
  if ("error" in ctx) return ctx;
  if (!REQUEST_STATUSES.has(status)) return { error: "Invalid status." };
  if (options?.message && options.message.length > MAX_MESSAGE) {
    return { error: `Messages are limited to ${MAX_MESSAGE} characters.` };
  }

  const { data: req } = await ctx.supabase
    .from("product_requests")
    .select("id, store_owner_email, store_owner_name, store_name")
    .eq("id", requestId)
    .eq("supplier_id", ctx.supplierId)
    .maybeSingle();
  if (!req) return { error: "Request not found." };

  const { error } = await ctx.supabase
    .from("product_requests")
    .update({ status })
    .eq("id", requestId)
    .eq("supplier_id", ctx.supplierId);
  if (error) return { error: friendlyError(error) };

  // Accepting a request creates an Order to fulfil (once).
  if (status === "accepted") {
    await createOrderFromRequest(ctx.supabase, ctx.supplierId, requestId, req);
  }

  const label: Record<RequestStatus, string> = {
    new: "reopened",
    accepted: "accepted",
    declined: "declined",
    proposed: "sent an alternative proposal for",
    fulfilled: "marked fulfilled",
  };

  await ctx.supabase
    .from("request_messages")
    .insert({ request_id: requestId, sender: "system", body: `Supplier ${label[status]} this request.` });

  const reply = options?.message?.trim();
  if (reply) {
    await ctx.supabase
      .from("request_messages")
      .insert({ request_id: requestId, sender: "supplier", body: reply });
  }

  if (req.store_owner_email) {
    await sendStoreOwnerEmail({
      to: req.store_owner_email,
      subject: `Your EcomStrait request was ${status}`,
      html: `<p>Update on your product request: it was <strong>${escapeHtml(status)}</strong>.</p>${
        reply ? `<p>${escapeHtml(reply)}</p>` : ""
      }`,
    });
  }

  revalidatePath("/requests");
  revalidatePath(`/requests/${requestId}`);
  return {};
}

/** Post a supplier reply to a request thread (and email the store owner). */
export async function addRequestMessage(
  requestId: string,
  body: string,
): Promise<{ error?: string }> {
  const ctx = await getSupplierContext();
  if ("error" in ctx) return ctx;

  const text = body.trim();
  if (!text) return { error: "Message is empty." };
  if (text.length > MAX_MESSAGE) return { error: `Messages are limited to ${MAX_MESSAGE} characters.` };

  const { data: req } = await ctx.supabase
    .from("product_requests")
    .select("id, store_owner_email")
    .eq("id", requestId)
    .eq("supplier_id", ctx.supplierId)
    .maybeSingle();
  if (!req) return { error: "Request not found." };

  const { error } = await ctx.supabase
    .from("request_messages")
    .insert({ request_id: requestId, sender: "supplier", body: text });
  if (error) return { error: friendlyError(error) };

  if (req.store_owner_email) {
    await sendStoreOwnerEmail({
      to: req.store_owner_email,
      subject: "New reply on your EcomStrait request",
      html: `<p>${escapeHtml(text)}</p>`,
    });
  }

  revalidatePath(`/requests/${requestId}`);
  return {};
}

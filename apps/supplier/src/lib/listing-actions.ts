"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@ecomstrait/db/admin";
import { requireApprovedSupplier } from "@/lib/supplier-context";
import { pushListingToShopify } from "@/lib/shopify-push";

export type ListingDecision = { error?: string; note?: string };

/**
 * Approve a merchant's request to list one of this supplier's products.
 *
 * Own-platform storefronts read approved rows live, so approval alone puts the
 * product on sale. Shopify stores need the product pushed into the shop, which
 * happens here so the merchant doesn't have to run a second step.
 */
export async function approveListing(
  storeId: string,
  productId: string,
): Promise<ListingDecision> {
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return { error: ctx.error };

  // Scoped by supplier_id: RLS permits the update, and this also stops a
  // supplier deciding a row that references someone else's product.
  const { data: updated, error } = await ctx.supabase
    .from("store_products")
    .update({ status: "approved", decided_at: new Date().toISOString(), decline_reason: null })
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .eq("supplier_id", ctx.supplierId)
    .select("store_id, product_id")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!updated) return { error: "That listing request is no longer available." };

  revalidatePath("/listings");

  const pushed = await pushListingToShopify(storeId, productId);
  return { note: pushed.note };
}

/** Decline a listing request, optionally telling the merchant why. */
export async function declineListing(
  storeId: string,
  productId: string,
  reason?: string,
): Promise<ListingDecision> {
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return { error: ctx.error };

  const { data: updated, error } = await ctx.supabase
    .from("store_products")
    .update({
      status: "declined",
      decided_at: new Date().toISOString(),
      decline_reason: reason?.trim()?.slice(0, 300) || null,
    })
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .eq("supplier_id", ctx.supplierId)
    .select("store_id")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!updated) return { error: "That listing request is no longer available." };

  revalidatePath("/listings");
  return { note: "Declined." };
}

/** Approve every pending request in one go. */
export async function approveAllPending(): Promise<{ approved: number; error?: string }> {
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return { approved: 0, error: ctx.error };

  const { data, error } = await ctx.supabase
    .from("store_products")
    .update({ status: "approved", decided_at: new Date().toISOString(), decline_reason: null })
    .eq("supplier_id", ctx.supplierId)
    .eq("status", "pending")
    .select("store_id, product_id");
  if (error) return { approved: 0, error: error.message };

  const rows = data ?? [];
  for (const r of rows) await pushListingToShopify(r.store_id, r.product_id);

  revalidatePath("/listings");
  return { approved: rows.length };
}

/** Admin client availability is a server concern — surfaced for the page gate. */
export async function listingsConfigured(): Promise<boolean> {
  return Boolean(createAdminClient());
}

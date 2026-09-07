"use server";

import { revalidatePath } from "next/cache";
import { getProfile } from "@ecomstrait/auth/session";
import { createAdminClient } from "@ecomstrait/db/admin";
import type { UserRole } from "@ecomstrait/db/types";

/**
 * Verify the caller is an admin (via their session), then hand back the
 * service-role client. Admin operations span tenants, so they must bypass the
 * owner-scoped RLS — but only after the session role check passes.
 */
async function asAdmin() {
  const profile = await getProfile();
  if (!profile || profile.role !== "admin") return { error: "Forbidden." as const };
  const client = createAdminClient();
  if (!client) return { error: "Server is not configured." as const };
  return { client };
}

/** Change a user's platform role (admin-only). Guards against self-lockout. */
export async function setUserRole(
  userId: string,
  role: UserRole,
): Promise<{ error?: string }> {
  const a = await asAdmin();
  if ("error" in a) return a;

  const me = await getProfile();
  if (me && me.user_id === userId && role !== "admin") {
    return { error: "You can't remove your own admin role." };
  }

  const { error } = await a.client.from("profiles").update({ role }).eq("user_id", userId);
  if (error) return { error: error.message };
  revalidatePath("/admin/users");
  return {};
}

export type SampleRequestInput = {
  storeName: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string;
  shipping?: string;
  timeline?: string;
  note?: string;
  productId?: string | null;
  productName: string;
  quantity: number;
  message?: string;
};

/**
 * Seed a store-owner request for a supplier, with admin-entered details
 * (until the merchant app generates real requests for every supplier —
 * see Docs/Supplier-Portal-Plan.md). Previously inserted the same hardcoded
 * "Nova Boutique" placeholder every time with a single click; now takes the
 * actual contact + shipping details an admin fills in, so what lands in a
 * supplier's inbox is deliberate, not a fixed canned row.
 */
export async function createSampleRequest(
  supplierId: string,
  input: SampleRequestInput,
): Promise<{ error?: string }> {
  const a = await asAdmin();
  if ("error" in a) return a;

  const storeName = input.storeName.trim();
  const contactName = input.contactName.trim();
  const contactEmail = input.contactEmail.trim();
  const productName = input.productName.trim();
  if (!storeName || !contactName || !contactEmail || !productName) {
    return { error: "Store name, contact name, contact email, and product are required." };
  }

  const { data: req, error } = await a.client
    .from("product_requests")
    .insert({
      supplier_id: supplierId,
      store_name: storeName,
      store_owner_name: contactName,
      store_owner_email: contactEmail,
      store_owner_phone: input.contactPhone?.trim() || null,
      shipping: input.shipping?.trim() || null,
      timeline: input.timeline?.trim() || null,
      note: input.note?.trim() || null,
      status: "new",
    })
    .select("id")
    .single();
  if (error) return { error: error.message };

  const quantity = Math.max(1, Math.round(input.quantity) || 1);
  await a.client.from("request_items").insert({
    request_id: req.id,
    product_id: input.productId || null,
    product_name: productName,
    quantity,
  });

  if (input.message?.trim()) {
    await a.client.from("request_messages").insert({
      request_id: req.id,
      sender: "store_owner",
      body: input.message.trim(),
    });
  }

  revalidatePath(`/admin/suppliers/${supplierId}`);
  return {};
}

export async function approveSupplier(id: string): Promise<{ error?: string }> {
  const a = await asAdmin();
  if ("error" in a) return a;
  const now = new Date().toISOString();

  const { error } = await a.client
    .from("suppliers")
    // Clears any earlier "return for edits" feedback — mirrors
    // approveListing clearing decline_reason on approval
    // (listing-actions.ts) — a stale checklist must not outlive approval.
    .update({ status: "approved", return_reasons: [], return_note: null })
    .eq("id", id);
  if (error) return { error: error.message };

  await a.client.from("supplier_verification").upsert(
    {
      supplier_id: id,
      documents_verified_at: now,
      manual_reviewed_at: now,
      badge_granted_at: now,
    },
    { onConflict: "supplier_id" },
  );

  revalidatePath("/admin/suppliers");
  revalidatePath(`/admin/suppliers/${id}`);
  return {};
}

export async function rejectSupplier(id: string): Promise<{ error?: string }> {
  const a = await asAdmin();
  if ("error" in a) return a;

  const { error } = await a.client.from("suppliers").update({ status: "rejected" }).eq("id", id);
  if (error) return { error: error.message };

  revalidatePath("/admin/suppliers");
  revalidatePath(`/admin/suppliers/${id}`);
  return {};
}

/** Manually mark the supplier's phone as verified (or clear it). */
export async function setPhoneVerified(
  id: string,
  verified: boolean,
): Promise<{ error?: string }> {
  const a = await asAdmin();
  if ("error" in a) return a;
  const { error } = await a.client.from("supplier_verification").upsert(
    { supplier_id: id, phone_verified_at: verified ? new Date().toISOString() : null },
    { onConflict: "supplier_id" },
  );
  if (error) return { error: error.message };
  revalidatePath(`/admin/suppliers/${id}`);
  return {};
}

/**
 * Store (or clear) the storefront password for a Shopify dev store. Dev stores
 * are password-locked; the assigned merchant reads this to preview their store.
 */
export async function setStorefrontPassword(
  shopifyStoreId: string,
  password: string,
): Promise<{ error?: string }> {
  const a = await asAdmin();
  if ("error" in a) return a;
  const value = password.trim();
  const { error } = await a.client
    .from("shopify_stores")
    .update({ storefront_password: value || null })
    .eq("id", shopifyStoreId);
  if (error) return { error: error.message };
  revalidatePath("/admin/shopify-stores");
  return {};
}

/** Send an application back for edits (e.g. request more info). */
export async function returnToPending(
  id: string,
  input: { reasons: string[]; note?: string },
): Promise<{ error?: string }> {
  const note = input.note?.trim().slice(0, 500) || null;
  const reasons = input.reasons.filter(Boolean);
  // A return with nothing checked and no note tells the supplier nothing —
  // same problem as the old one-click version, now actually prevented.
  if (reasons.length === 0 && !note) {
    return { error: "Select at least one item or add a note before sending it back." };
  }

  const a = await asAdmin();
  if ("error" in a) return a;
  const { error } = await a.client
    .from("suppliers")
    .update({ status: "pending", return_reasons: reasons, return_note: note })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/admin/suppliers");
  revalidatePath(`/admin/suppliers/${id}`);
  return {};
}

/**
 * Complete a "Make it yours" handover.
 *
 * The transfer itself happens in Shopify (Settings → Users → transfer
 * ownership); this records that it's done, which is what flips the merchant's
 * badge to "Yours". The store leaves our pool for good — it now belongs to the
 * merchant's Shopify account and must never be reassigned to someone else.
 */
export async function markStoreTransferred(
  shopifyStoreId: string,
): Promise<{ error?: string }> {
  const a = await asAdmin();
  if ("error" in a) return a;

  const { data: shop } = await a.client
    .from("shopify_stores")
    .select("id, status, transfer_email")
    .eq("id", shopifyStoreId)
    .maybeSingle();
  if (!shop) return { error: "Store not found." };
  if (!shop.transfer_email) {
    return { error: "No transfer has been requested for this store." };
  }
  if (shop.status === "transferred") return {};

  const { error } = await a.client
    .from("shopify_stores")
    .update({
      status: "transferred",
      transferred_at: new Date().toISOString(),
      sync_status: `transferred to ${shop.transfer_email}`,
    })
    .eq("id", shopifyStoreId);
  if (error) return { error: error.message };

  revalidatePath("/admin/shopify-stores");
  return {};
}

/**
 * Cancel a pending transfer request — e.g. the merchant gave the wrong email,
 * or changed their mind. Returns the store to the merchant's assigned state
 * rather than the free pool: they still own it here.
 */
export async function cancelStoreTransfer(
  shopifyStoreId: string,
): Promise<{ error?: string }> {
  const a = await asAdmin();
  if ("error" in a) return a;

  const { data: shop } = await a.client
    .from("shopify_stores")
    .select("id, status")
    .eq("id", shopifyStoreId)
    .maybeSingle();
  if (!shop) return { error: "Store not found." };
  if (shop.status === "transferred") {
    return { error: "This store has already been transferred." };
  }

  const { error } = await a.client
    .from("shopify_stores")
    .update({
      status: "assigned",
      transfer_email: null,
      transfer_requested_at: null,
      sync_status: "transfer request cancelled",
    })
    .eq("id", shopifyStoreId);
  if (error) return { error: error.message };

  revalidatePath("/admin/shopify-stores");
  return {};
}

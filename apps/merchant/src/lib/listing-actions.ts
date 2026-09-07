"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@ecomstrait/auth/server";
import { createAdminClient } from "@ecomstrait/db/admin";
import { wipeStoreContent } from "@/lib/shopify";
import type { ListingStatus } from "@ecomstrait/db/types";

export type MerchantStore = {
  id: string;
  name: string;
  /** This product's state on that store, or null when it isn't listed there. */
  listing: ListingStatus | null;
};

/**
 * The merchant's stores, annotated with where `productId` already stands on
 * each — so the "Add to store" menu can show Pending / Listed instead of
 * offering a duplicate.
 */
export async function getStoresForProduct(productId: string): Promise<MerchantStore[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: stores } = await supabase
    .from("stores")
    .select("id, name")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (!stores?.length) return [];

  const { data: listings } = await supabase
    .from("store_products")
    .select("store_id, status")
    .eq("product_id", productId)
    .in(
      "store_id",
      stores.map((s) => s.id),
    );

  const byStore = new Map((listings ?? []).map((l) => [l.store_id, l.status]));
  return stores.map((s) => ({
    id: s.id,
    name: s.name ?? "Untitled store",
    listing: byStore.get(s.id) ?? null,
  }));
}

/**
 * Request that a supplier's product be listed on one of the merchant's stores.
 * Creates a PENDING row — nothing reaches the storefront or Shopify until the
 * supplier approves it.
 */
export async function requestListing(
  storeId: string,
  productId: string,
): Promise<{ error?: string; status?: ListingStatus }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data: store } = await supabase
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!store) return { error: "Store not found." };

  // The catalog is cross-tenant, so the product and its price come from the
  // admin client — a merchant can't read another supplier's rows directly.
  const admin = createAdminClient();
  if (!admin) return { error: "Server not configured." };
  const { data: product } = await admin
    .from("products")
    .select("id, supplier_id, retail_price, status")
    .eq("id", productId)
    .maybeSingle();
  if (!product) return { error: "Product not found." };
  if (product.status !== "published") return { error: "That product isn't published." };

  // Insert-only. This used to upsert with status "pending" and the retail
  // price, so asking twice reset an approved listing and wiped the
  // merchant's own price. An existing row is simply reported back.
  const { data: current } = await supabase
    .from("store_products")
    .select("status")
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .maybeSingle();
  if (current) return { status: current.status as ListingStatus };

  const { error } = await supabase.from("store_products").insert({
    store_id: storeId,
    product_id: productId,
    supplier_id: product.supplier_id,
    price: product.retail_price,
    status: "pending" as ListingStatus,
  });
  if (error) {
    if (error.code === "23505") return { status: "pending" };
    console.error("[listings] request failed:", error);
    return { error: "Couldn't send the listing request. Please try again." };
  }

  revalidatePath("/find-suppliers");
  revalidatePath("/inventory");
  revalidatePath(`/stores/${storeId}`);
  return { status: "pending" };
}

/**
 * Adjust the merchant's own selling price for a listing already on one of
 * their stores. `store_products.price` starts out seeded from the
 * supplier's MSRP (requestListing/createStore) with no merchant input at
 * all — this is the actual "adjust it" surface.
 *
 * The MAP check here is fast feedback, not the real guarantee: the DB has
 * its own unconditional trigger (store_products_map_price_guard,
 * supabase/migrations/20260902120000_products_map_price.sql) that rejects
 * the write regardless of caller, so this can't be bypassed by skipping
 * this action.
 */
export async function updateListingPrice(
  storeId: string,
  productId: string,
  price: number,
): Promise<{ error?: string }> {
  if (!Number.isFinite(price) || price <= 0) {
    return { error: "Enter a valid price." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data: store } = await supabase
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!store) return { error: "Store not found." };

  const admin = createAdminClient();
  if (!admin) return { error: "Server not configured." };
  const { data: product } = await admin
    .from("products")
    .select("map_price")
    .eq("id", productId)
    .maybeSingle();
  if (!product) return { error: "Product not found." };
  if (product.map_price != null && price < product.map_price) {
    return { error: `Can't price below the MAP ($${product.map_price.toFixed(2)}) set by the supplier.` };
  }

  const { error } = await supabase
    .from("store_products")
    .update({ price })
    .eq("store_id", storeId)
    .eq("product_id", productId);
  if (error) return { error: error.message };

  revalidatePath("/inventory");
  return {};
}

const SHIPPING_NOTE_MAX = 140;

/**
 * Set the merchant's own one-line shipping/returns note for a listing.
 *
 * Store-specific by design (a merchant may run different shipping/returns
 * terms per store even for the same supplier product), so it lives on
 * `store_products` rather than `products`. An empty string clears it.
 */
export async function updateListingShippingNote(
  storeId: string,
  productId: string,
  note: string,
): Promise<{ error?: string }> {
  const trimmed = note.trim();
  if (trimmed.length > SHIPPING_NOTE_MAX) {
    return { error: `Keep it under ${SHIPPING_NOTE_MAX} characters.` };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data: store } = await supabase
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!store) return { error: "Store not found." };

  const { error } = await supabase
    .from("store_products")
    .update({ shipping_note: trimmed || null })
    .eq("store_id", storeId)
    .eq("product_id", productId);
  if (error) return { error: error.message };

  revalidatePath("/inventory");
  return {};
}

/** Remove a listing (or withdraw a pending request) from one of the merchant's stores. */
export async function removeListing(
  storeId: string,
  productId: string,
): Promise<{ error?: string; note?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data: store } = await supabase
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!store) return { error: "Store not found." };

  // Pull it from Shopify BEFORE deleting the row — the row holds the only link
  // to the Shopify product, so deleting first would strand it there for good.
  // Custom-website storefronts need nothing: they read approved listings live.
  let note: string | undefined;
  const admin = createAdminClient();
  if (admin) {
    const { data: listing } = await admin
      .from("store_products")
      .select("shopify_product_id")
      .eq("store_id", storeId)
      .eq("product_id", productId)
      .maybeSingle();

    if (listing?.shopify_product_id) {
      const { data: full } = await admin
        .from("stores")
        .select("shopify_store_id")
        .eq("id", storeId)
        .maybeSingle();
      const { data: shop } = full?.shopify_store_id
        ? await admin
            .from("shopify_stores")
            .select("shop_domain, access_token")
            .eq("id", full.shopify_store_id)
            .maybeSingle()
        : { data: null };

      if (shop?.access_token) {
        const wipe = await wipeStoreContent(shop.shop_domain, shop.access_token, {
          productIds: [listing.shopify_product_id],
        });
        // Leaving the row would strand the listing in our UI too, so the delete
        // proceeds either way — but say so rather than claiming a clean removal.
        if (wipe.errors.length) {
          note = "Removed here, but it may still be visible on Shopify — check the store.";
        }
      }
    }
  }

  const { error } = await supabase
    .from("store_products")
    .delete()
    .eq("store_id", storeId)
    .eq("product_id", productId);
  if (error) return { error: error.message };

  revalidatePath("/find-suppliers");
  revalidatePath("/inventory");
  revalidatePath(`/store/${storeId}`);
  return note ? { note } : {};
}

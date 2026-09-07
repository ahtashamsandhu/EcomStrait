import { createClient } from "@ecomstrait/auth/server";
import { createAdminClient } from "@ecomstrait/db/admin";
import { productImage } from "@/lib/catalog";
import type { ListingStatus } from "@ecomstrait/db/types";

export type StoreOption = { id: string; name: string };
/** productId → the merchant's listing state for it, per store. */
export type ListingMap = Record<string, Record<string, ListingStatus>>;

/** The current merchant's stores, newest first. */
export async function getMerchantStores(): Promise<StoreOption[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from("stores")
    .select("id, name")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (data ?? []).map((s) => ({ id: s.id, name: s.name ?? "Untitled store" }));
}

/**
 * Listing state for a page of products in one query, rather than one lookup per
 * card. Returns `{}` when the merchant has no stores yet.
 */
export async function getListingsFor(productIds: string[]): Promise<ListingMap> {
  if (!productIds.length) return {};

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return {};

  const { data: stores } = await supabase.from("stores").select("id").eq("user_id", user.id);
  const storeIds = (stores ?? []).map((s) => s.id);
  if (!storeIds.length) return {};

  const { data } = await supabase
    .from("store_products")
    .select("store_id, product_id, status")
    .in("store_id", storeIds)
    .in("product_id", productIds);

  const map: ListingMap = {};
  for (const row of data ?? []) {
    (map[row.product_id] ??= {})[row.store_id] = row.status;
  }
  return map;
}

export type MerchantListing = {
  productId: string;
  title: string;
  image: string | null;
  price: number | null;
  /** The supplier's suggested price (products.retail_price) — reference
   *  only, shown alongside the editable price, never enforced on its own. */
  msrp: number | null;
  /** The supplier's price floor (products.map_price), when set — enforced
   *  both here (fast feedback) and by a DB trigger on store_products
   *  (the actual guarantee, see updateListingPrice). */
  mapPrice: number | null;
  supplierName: string;
  storeId: string;
  storeName: string;
  status: ListingStatus;
  declineReason: string | null;
  /** Merchant-set, per store — see updateListingShippingNote. */
  shippingNote: string | null;
};

/**
 * Everything this merchant has listed, optionally narrowed to one store.
 *
 * Products and supplier names live across tenants, so those reads go through
 * the admin client — but the set of store ids comes from the caller's own
 * stores first, which is what scopes the result.
 */
export async function getMerchantListings(storeId?: string): Promise<MerchantListing[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: stores } = await supabase
    .from("stores")
    .select("id, name")
    .eq("user_id", user.id);
  const mine = (stores ?? []).filter((s) => !storeId || s.id === storeId);
  if (!mine.length) return [];
  const storeNames = new Map(mine.map((s) => [s.id, s.name ?? "Untitled store"]));

  const { data: rows } = await supabase
    .from("store_products")
    .select("store_id, product_id, price, status, decline_reason, shipping_note, created_at")
    .in(
      "store_id",
      mine.map((s) => s.id),
    )
    .order("created_at", { ascending: false });
  if (!rows?.length) return [];

  const admin = createAdminClient();
  if (!admin) return [];
  const productIds = [...new Set(rows.map((r) => r.product_id))];
  const { data: products } = await admin
    .from("products")
    .select("id, title, images, retail_price, map_price, supplier_id")
    .in("id", productIds);
  const byId = new Map((products ?? []).map((p) => [p.id, p]));

  const supplierIds = [...new Set((products ?? []).map((p) => p.supplier_id))];
  const supplierNames = new Map<string, string>();
  if (supplierIds.length) {
    const { data: sups } = await admin
      .from("suppliers")
      .select("id, business_name")
      .in("id", supplierIds);
    (sups ?? []).forEach((s) => supplierNames.set(s.id, s.business_name ?? "Supplier"));
  }

  return rows.flatMap((r) => {
    const p = byId.get(r.product_id);
    if (!p) return [];
    return [
      {
        productId: r.product_id,
        title: p.title,
        image: productImage(p.images?.[0]),
        price: r.price ?? p.retail_price,
        msrp: p.retail_price,
        mapPrice: p.map_price,
        supplierName: supplierNames.get(p.supplier_id) ?? "Supplier",
        storeId: r.store_id,
        storeName: storeNames.get(r.store_id) ?? "Untitled store",
        status: r.status,
        declineReason: r.decline_reason,
        shippingNote: r.shipping_note,
      },
    ];
  });
}

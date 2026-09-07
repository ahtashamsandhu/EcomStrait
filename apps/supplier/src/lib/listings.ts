import { createAdminClient } from "@ecomstrait/db/admin";
import type { ListingStatus } from "@ecomstrait/db/types";
import { getMySupplier } from "@/lib/supplier-context";

export type ListingRequest = {
  storeId: string;
  productId: string;
  productTitle: string;
  productImage: string | null;
  storeName: string;
  storeType: string;
  merchantEmail: string | null;
  price: number | null;
  status: ListingStatus;
  createdAt: string;
  declineReason: string | null;
};

function imageUrl(path?: string | null): string | null {
  if (!path) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return base ? `${base}/storage/v1/object/public/product-images/${path}` : null;
}

/**
 * Listing requests against this supplier's products.
 *
 * Stores and merchant emails belong to other tenants, so the joins run through
 * the admin client — the supplier's own rows are still the only ones fetched,
 * scoped by supplier_id.
 */
export async function getListingRequests(
  status: ListingStatus,
  limit = 200,
): Promise<ListingRequest[]> {
  const supplier = await getMySupplier();
  if (!supplier || supplier.status !== "approved") return [];

  const admin = createAdminClient();
  if (!admin) return [];

  const { data: rows } = await admin
    .from("store_products")
    .select("store_id, product_id, price, status, created_at, decline_reason")
    .eq("supplier_id", supplier.supplierId)
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (!rows?.length) return [];

  const storeIds = [...new Set(rows.map((r) => r.store_id))];
  const productIds = [...new Set(rows.map((r) => r.product_id))];

  const [{ data: stores }, { data: products }] = await Promise.all([
    admin.from("stores").select("id, name, type, user_id").in("id", storeIds),
    admin.from("products").select("id, title, images").in("id", productIds),
  ]);

  const storeById = new Map((stores ?? []).map((s) => [s.id, s]));
  const productById = new Map((products ?? []).map((p) => [p.id, p]));

  const ownerIds = [...new Set((stores ?? []).map((s) => s.user_id).filter(Boolean))];
  const emailById = new Map<string, string>();
  if (ownerIds.length) {
    const { data: authList } = await admin.auth.admin.listUsers({ perPage: 200 });
    (authList?.users ?? []).forEach((u) => {
      if (u.email && ownerIds.includes(u.id)) emailById.set(u.id, u.email);
    });
  }

  return rows.map((r) => {
    const store = storeById.get(r.store_id);
    const product = productById.get(r.product_id);
    return {
      storeId: r.store_id,
      productId: r.product_id,
      productTitle: product?.title ?? "Product",
      productImage: imageUrl(product?.images?.[0]),
      storeName: store?.name ?? "Untitled store",
      storeType: store?.type ?? "own_platform",
      merchantEmail: store?.user_id ? (emailById.get(store.user_id) ?? null) : null,
      price: r.price,
      status: r.status,
      createdAt: r.created_at,
      declineReason: r.decline_reason,
    };
  });
}

/** Pending count for the nav badge. */
export async function getPendingListingCount(): Promise<number> {
  const supplier = await getMySupplier();
  if (!supplier || supplier.status !== "approved") return 0;
  const admin = createAdminClient();
  if (!admin) return 0;
  const { count } = await admin
    .from("store_products")
    .select("product_id", { count: "exact", head: true })
    .eq("supplier_id", supplier.supplierId)
    .eq("status", "pending");
  return count ?? 0;
}

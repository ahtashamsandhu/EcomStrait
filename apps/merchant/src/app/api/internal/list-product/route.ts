import { NextResponse } from "next/server";
import { verifyInternalRequest } from "@/lib/secret-compare";
import { createAdminClient } from "@ecomstrait/db/admin";
import { withOpenToken } from "@/lib/token-crypto";
import { pushProductsToShopify } from "@/lib/shopify";
import { productImage } from "@/lib/catalog";

export const runtime = "nodejs";

/**
 * Push one approved listing into the merchant's Shopify store.
 *
 * The supplier portal calls this when a supplier approves a listing: Shopify
 * credentials and the GraphQL client live here, so this app stays the only one
 * that talks to Shopify. Authenticated by a signed, timestamped request from
 * the supplier app (see verifyInternalRequest).
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyInternalRequest(req, raw)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { storeId?: string; productId?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const storeId = body.storeId?.trim();
  const productId = body.productId?.trim();
  if (!storeId || !productId) {
    return NextResponse.json({ error: "storeId and productId required" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // Only push what the supplier actually approved.
  const { data: listing } = await admin
    .from("store_products")
    .select("status, price")
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .maybeSingle();
  if (!listing) return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  if (listing.status !== "approved") {
    return NextResponse.json({ error: "Listing is not approved" }, { status: 409 });
  }

  const { data: store } = await admin
    .from("stores")
    .select("id, type, shopify_store_id")
    .eq("id", storeId)
    .maybeSingle();
  if (!store) return NextResponse.json({ error: "Store not found" }, { status: 404 });

  // Own-platform storefronts read approved rows live — nothing to push.
  if (store.type === "own_platform") {
    return NextResponse.json({ pushed: false, reason: "own_platform" });
  }
  if (!store.shopify_store_id) {
    return NextResponse.json({ pushed: false, reason: "not_provisioned" });
  }

  const { data: rawShop } = await admin
    .from("shopify_stores")
    .select("shop_domain, access_token")
    .eq("id", store.shopify_store_id)
    .maybeSingle();
  const shop = withOpenToken(rawShop);
  if (!shop?.access_token) {
    return NextResponse.json({ pushed: false, reason: "no_token" });
  }

  const { data: product } = await admin
    .from("products")
    .select("id, title, description, images, stock, reserved")
    .eq("id", productId)
    .maybeSingle();
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });

  // Must carry the same payload as provisioning and Sync products, or a product
  // approved through this path lands with no image and untracked stock.
  const result = await pushProductsToShopify(shop.shop_domain, shop.access_token, [
    {
      title: product.title,
      description: product.description ?? null,
      price: listing.price,
      sku: product.id, // lets the order webhook map back to our product
      inventory: Math.max(0, (product.stock ?? 0) - (product.reserved ?? 0)),
      images: (product.images ?? [])
        .map((i: string) => productImage(i))
        .filter((u): u is string => Boolean(u)),
    },
  ]);

  // Record which Shopify product this listing became, so later syncs and
  // removal can find it.
  const created = result.ids.get(product.id);
  if (created) {
    await admin
      .from("store_products")
      .update({
        shopify_product_id: created.id,
        shopify_handle: created.handle,
        shopify_synced_at: new Date().toISOString(),
      })
      .eq("store_id", storeId)
      .eq("product_id", productId);
  }

  if (result.errors.length) {
    return NextResponse.json({ pushed: false, errors: result.errors }, { status: 502 });
  }
  return NextResponse.json({ pushed: result.created > 0 });
}

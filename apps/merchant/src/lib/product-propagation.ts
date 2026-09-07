import "server-only";
import { createAdminClient } from "@ecomstrait/db/admin";
import { withOpenToken } from "@/lib/token-crypto";
import { alertListingBelowCost } from "@/lib/ops-alert";
import { productImage } from "@/lib/catalog";
import {
  updateShopifyProductContent,
  setShopifyProductStock,
  setShopifyProductStatus,
  setShopifyProductPrice,
  backfillProductMedia,
} from "@/lib/shopify";

/**
 * Push a supplier product's current state out to every store selling it.
 *
 * Custom-website storefronts read our tables live and need nothing. Shopify
 * stores hold independent copies, so without this a supplier's edit never
 * lands and — more seriously — a sale on one store leaves every other store
 * still advertising stock that's gone.
 *
 * Price is pushed from `store_products.price` — the listing's own price, not
 * the supplier's retail price. Cascading a supplier's price change into that
 * column is a separate, deliberate step (`cascadeSupplierPrice`), so a merchant
 * who has set their own margin keeps it.
 */

export type PropagateResult = {
  stores: number;
  updated: number;
  errors: string[];
};

export async function propagateProduct(
  productId: string,
  opts: {
    content?: boolean;
    stock?: boolean;
    price?: boolean;
    status?: boolean;
    skipStoreId?: string;
  } = {},
): Promise<PropagateResult> {
  const out: PropagateResult = { stores: 0, updated: 0, errors: [] };
  const admin = createAdminClient();
  if (!admin) return out;

  const { data: product } = await admin
    .from("products")
    .select("id, title, description, images, stock, reserved, status")
    .eq("id", productId)
    .maybeSingle();
  if (!product) return out;

  // Only approved listings that actually reached Shopify can be updated.
  const { data: listings } = await admin
    .from("store_products")
    .select("store_id, shopify_product_id, price")
    .eq("product_id", productId)
    .eq("status", "approved")
    .not("shopify_product_id", "is", null);
  if (!listings?.length) return out;

  const storeIds = [...new Set(listings.map((l) => l.store_id))];
  const { data: stores } = await admin
    .from("stores")
    .select("id, shopify_store_id")
    .in("id", storeIds)
    .not("shopify_store_id", "is", null);
  const shopIdByStore = new Map((stores ?? []).map((s) => [s.id, s.shopify_store_id as string]));

  const shopIds = [...new Set([...shopIdByStore.values()])];
  if (!shopIds.length) return out;
  const { data: shops } = await admin
    .from("shopify_stores")
    .select("id, shop_domain, access_token")
    .in("id", shopIds);
  const shopById = new Map((shops ?? []).map((s) => [s.id, withOpenToken(s)!]));

  const available = Math.max(0, (product.stock ?? 0) - (product.reserved ?? 0));
  // A drafted product must disappear from every storefront selling it.
  const shopStatus = product.status === "published" ? "ACTIVE" : "DRAFT";

  for (const listing of listings) {
    if (opts.skipStoreId && listing.store_id === opts.skipStoreId) continue;
    const shopId = shopIdByStore.get(listing.store_id);
    const shop = shopId ? shopById.get(shopId) : undefined;
    if (!shop?.access_token || !listing.shopify_product_id) continue;

    out.stores += 1;
    let changed = false;

    if (opts.content) {
      const res = await updateShopifyProductContent(
        shop.shop_domain,
        shop.access_token,
        listing.shopify_product_id,
        { title: product.title, description: product.description },
      );
      if (res.ok) changed = true;
      else out.errors.push(`${shop.shop_domain}: ${res.error}`);
    }

    if (opts.price && listing.price != null) {
      const res = await setShopifyProductPrice(
        shop.shop_domain,
        shop.access_token,
        listing.shopify_product_id,
        listing.price,
      );
      if (res.ok) changed = true;
      else out.errors.push(`${shop.shop_domain}: ${res.error}`);
    }

    if (opts.status) {
      const res = await setShopifyProductStatus(
        shop.shop_domain,
        shop.access_token,
        listing.shopify_product_id,
        shopStatus,
      );
      if (res.ok) changed = true;
      else out.errors.push(`${shop.shop_domain}: ${res.error}`);
    }

    if (opts.stock) {
      const res = await setShopifyProductStock(
        shop.shop_domain,
        shop.access_token,
        listing.shopify_product_id,
        available,
      );
      if (res.ok) changed = true;
      else out.errors.push(`${shop.shop_domain}: ${res.error}`);

      // Adding images is safe; replacing them isn't, so we only fill a gap.
      if (opts.content && res.mediaCount === 0) {
        const urls = (product.images ?? [])
          .map((i: string) => productImage(i))
          .filter((u): u is string => Boolean(u));
        if (urls.length) {
          await backfillProductMedia(shop.shop_domain, shop.access_token, [
            { productId: listing.shopify_product_id, title: product.title, images: urls },
          ]);
        }
      }
    }

    if (changed) out.updated += 1;
  }

  return out;
}

/**
 * Fan out a stock change caused by a sale.
 *
 * Best-effort and non-blocking by design: an order must be recorded even if a
 * shop is unreachable, so failures are logged rather than thrown.
 */
export async function propagateStockAfterSale(productIds: string[]): Promise<void> {
  for (const id of [...new Set(productIds)]) {
    try {
      const res = await propagateProduct(id, { stock: true });
      if (res.errors.length) {
        console.error("[propagate] stock fan-out had errors:", res.errors.slice(0, 3).join("; "));
      }
    } catch (e) {
      console.error("[propagate] stock fan-out failed:", e);
    }
  }
}

/**
 * Move listing prices to follow a supplier's new retail price.
 *
 * A listing starts at the supplier's retail price, so one still sitting at the
 * *old* value was never repriced by the merchant and should follow. One that
 * differs is a deliberate margin choice and is left alone — but a supplier
 * raising their price can push such a listing below cost, so that case alerts
 * the team (merchants have no in-app alerting yet).
 *
 * Without `previousPrice` (an older caller, or a path that didn't capture it)
 * nothing is cascaded: silently repricing a merchant's storefront is the worse
 * failure.
 */
export async function cascadeSupplierPrice(
  productId: string,
  previousPrice: number | null | undefined,
): Promise<{ followed: number; kept: number }> {
  const out = { followed: 0, kept: 0 };
  if (previousPrice == null) return out;

  const admin = createAdminClient();
  if (!admin) return out;

  const { data: product } = await admin
    .from("products")
    .select("title, retail_price, wholesale_price")
    .eq("id", productId)
    .maybeSingle();
  const next = product?.retail_price;
  if (next == null || Number(next) === Number(previousPrice)) return out;

  const { data: listings } = await admin
    .from("store_products")
    .select("store_id, price")
    .eq("product_id", productId);
  if (!listings?.length) return out;

  const following = listings.filter((l) => Number(l.price) === Number(previousPrice));
  const kept = listings.filter((l) => Number(l.price) !== Number(previousPrice));
  out.kept = kept.length;

  const cost = product?.wholesale_price;
  if (cost != null) {
    const losing = kept
      .filter((l) => l.price != null && Number(l.price) < Number(cost))
      .map((l) => ({ storeId: l.store_id, price: Number(l.price) }));
    if (losing.length) await alertListingBelowCost(product?.title ?? productId, losing, Number(cost));
  }

  if (!following.length) return out;

  const { error } = await admin
    .from("store_products")
    .update({ price: next })
    .eq("product_id", productId)
    .eq("price", previousPrice);
  if (error) {
    console.error("[propagate] price cascade failed:", error.message);
    return out;
  }
  out.followed = following.length;
  return out;
}

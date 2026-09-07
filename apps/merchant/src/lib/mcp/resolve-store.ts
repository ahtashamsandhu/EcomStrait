import { createAdminClient } from "@ecomstrait/db/admin";
import { openToken } from "@/lib/token-crypto";

export type ShopifyCredentials = { shop: string; token: string };

/**
 * Resolve a merchant-facing `storeId` (the `stores` table) to the Shopify
 * shop/token it's connected to.
 *
 * Shared by the Shopify MCP server (`./shopify-server.ts`) and the Business
 * Advisor's Shopify tools (`../agents/shopify-tools.ts`) — never trust a
 * caller-supplied shop/token, so a bad or someone-else's storeId fails
 * cleanly instead of touching the wrong shop.
 */
export async function resolveStoreCredentials(storeId: string): Promise<ShopifyCredentials | null> {
  const client = createAdminClient();
  if (!client) return null;

  const { data: store } = await client
    .from("stores")
    .select("shopify_store_id")
    .eq("id", storeId)
    .single();
  if (!store?.shopify_store_id) return null;

  const { data: shopifyStore } = await client
    .from("shopify_stores")
    .select("shop_domain, access_token")
    .eq("id", store.shopify_store_id)
    .single();
  const token = openToken(shopifyStore?.access_token);
  if (!shopifyStore || !token) return null;

  return { shop: shopifyStore.shop_domain, token };
}

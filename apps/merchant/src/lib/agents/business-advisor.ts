import { runOrchestrator, type OrchestratorResult } from "@ecomstrait/ai";
import { createAdminClient } from "@ecomstrait/db/admin";
import { createShopifyTools } from "./shopify-tools";
import { createShopifyWriteTools } from "./shopify-write-tools";

/**
 * "This store's id is X" alone doesn't let the agent filter a query — it
 * can see rows, but has no name/domain to match "this store" against
 * without this. Best-effort: a lookup failure degrades to no context
 * (the agent then correctly declines to guess) rather than blocking the
 * question.
 */
async function describeStore(storeId: string): Promise<string> {
  const client = createAdminClient();
  if (!client) return `store id: ${storeId}`;

  const { data: store } = await client
    .from("stores")
    .select("name, type, shopify_store_id")
    .eq("id", storeId)
    .single();

  const parts = [`store id: ${storeId}`, `store name: ${store?.name ?? "unknown"}`, `store type: ${store?.type ?? "unknown"}`];

  if (store?.shopify_store_id) {
    const { data: shopifyStore } = await client
      .from("shopify_stores")
      .select("shop_domain")
      .eq("id", store.shopify_store_id)
      .single();
    if (shopifyStore?.shop_domain) parts.push(`Shopify domain: ${shopifyStore.shop_domain}`);
  }

  return parts.join(", ");
}

/**
 * Merchant-facing entry point: the generic orchestrator from `@ecomstrait/ai`,
 * with this app's Shopify tools injected and this store's identity given as
 * context. `threadId` is the storeId — one conversation thread per store
 * keeps this simple for now; a merchant with several stores gets separate
 * advisor context per store, which matches how they already think about
 * "my store" when asking a question.
 */
export async function askBusinessAdvisor(params: {
  tenantId: string;
  storeId: string;
  message: string;
}): Promise<OrchestratorResult> {
  const context = `You are discussing the following store: ${await describeStore(params.storeId)}. Filter every query to this store.`;

  return runOrchestrator({
    tenantId: params.tenantId,
    threadId: params.storeId,
    message: params.message,
    context,
    extraTools: [
      ...createShopifyTools(params.storeId),
      ...createShopifyWriteTools({ tenantId: params.tenantId, storeId: params.storeId }),
    ],
  });
}

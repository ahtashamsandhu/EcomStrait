import "server-only";
import { createAdminClient } from "@ecomstrait/db/admin";
import { decideRestock, requestApproval } from "@ecomstrait/ai";
import { alertRestockRecommended } from "@/lib/ops-alert";
import type { SoldItem } from "@/lib/order-sink";

/**
 * Runs in-process from the Shopify order webhook's `after()` block — not via
 * n8n. The original Phase 6 design routed this through an n8n workflow, but
 * that added an outbound call, an inbound endpoint, and a second secret for
 * something that's one function call entirely within our own DB and Shopify
 * integration: the same reasoning that already keeps the orchestrator
 * calling Shopify tools directly instead of round-tripping through the MCP
 * HTTP endpoint. See Docs/AI-Native-Migration-Plan.md, Phase 6.
 *
 * Best-effort throughout — a failure here must never affect order recording,
 * which has already completed by the time this runs.
 */
export async function checkRestockAfterSale(items: SoldItem[]): Promise<void> {
  const client = createAdminClient();
  if (!client) return;

  for (const item of items) {
    if (!item.product_id || item.quantity <= 0) continue;
    try {
      await checkOneProduct(client, item.product_id, item.quantity);
    } catch (err) {
      console.error("[restock-check] failed for product", item.product_id, err);
    }
  }
}

async function checkOneProduct(
  client: NonNullable<ReturnType<typeof createAdminClient>>,
  productId: string,
  quantitySold: number,
): Promise<void> {
  const { data: product } = await client
    .from("products")
    .select("id, title, stock, low_stock_threshold, supplier_id")
    .eq("id", productId)
    .maybeSingle();
  if (!product) return;

  const { data: supplier } = await client
    .from("suppliers")
    .select("owner_user_id")
    .eq("id", product.supplier_id)
    .maybeSingle();
  if (!supplier?.owner_user_id) return;

  const decision = await decideRestock({
    productTitle: product.title,
    currentStock: product.stock,
    lowStockThreshold: product.low_stock_threshold,
    quantitySold,
  });
  if (!decision.shouldRestock) return;

  // Same principle as the Shopify write tools in Phase 5: propose, never
  // execute directly. Approving it is what actually adjusts `products.stock`
  // — see the "inventory.restock" case in app/api/admin/approvals/[id]/route.ts.
  const approval = await requestApproval({
    tenantId: supplier.owner_user_id,
    threadId: product.id,
    action: "inventory.restock",
    payload: { productId: product.id, quantity: decision.quantity, reasoning: decision.reasoning },
  });

  await alertRestockRecommended(product.title, decision.quantity, decision.reasoning, approval.id);
}

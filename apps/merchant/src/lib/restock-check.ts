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
    .select("id, title, stock, low_stock_threshold, supplier_id, wholesale_price")
    .eq("id", productId)
    .maybeSingle();
  if (!product) return;

  const { data: supplier } = await client
    .from("suppliers")
    .select("owner_user_id")
    .eq("id", product.supplier_id)
    .maybeSingle();
  if (!supplier?.owner_user_id) return;

  // Sales velocity from the real line-items table (order_items joined to
  // orders) — the same tables catalog.ts's getPlatformTopSellers scans.
  // Optional on the agent side: when this fails, decideRestock falls back
  // to its limited-signal heuristic wording rather than the whole check
  // failing.
  const velocity = await loadSalesVelocity(client, productId);

  const decision = await decideRestock({
    productTitle: product.title,
    currentStock: product.stock,
    lowStockThreshold: product.low_stock_threshold,
    quantitySold,
    ...(velocity ?? {}),
    wholesalePrice: product.wholesale_price,
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

/**
 * Units of one product sold in the last 7 and 30 days across non-cancelled
 * orders. Two bounded queries rather than an embedded join: `order_items`
 * has no declared FK relationship in packages/db's generated types, so a
 * `orders!inner(...)` select wouldn't type-check, and a single product's
 * line items are a small set to scan. Returns null on any failure so the
 * caller can omit velocity (the agent then uses its no-velocity prompt).
 */
async function loadSalesVelocity(
  client: NonNullable<ReturnType<typeof createAdminClient>>,
  productId: string,
): Promise<{ unitsSoldLast7Days: number; unitsSoldLast30Days: number } | null> {
  try {
    const now = Date.now();
    const since30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const since7 = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: items, error: itemsErr } = await client
      .from("order_items")
      .select("order_id, quantity")
      .eq("product_id", productId)
      .limit(5000);
    if (itemsErr) throw itemsErr;
    if (!items?.length) return { unitsSoldLast7Days: 0, unitsSoldLast30Days: 0 };

    // Chunked `.in()` — PostgREST filters travel in the URL, so a long id
    // list has to be split rather than sent in one request.
    const orderIds = [...new Set(items.map((it) => it.order_id))];
    const createdAtByOrder = new Map<string, number>();
    for (let i = 0; i < orderIds.length; i += 200) {
      const { data: orders, error: ordersErr } = await client
        .from("orders")
        .select("id, created_at")
        .in("id", orderIds.slice(i, i + 200))
        .gte("created_at", since30)
        .neq("status", "cancelled");
      if (ordersErr) throw ordersErr;
      for (const o of orders ?? []) createdAtByOrder.set(o.id, Date.parse(o.created_at));
    }

    const since7Ms = Date.parse(since7);
    let units30 = 0;
    let units7 = 0;
    for (const it of items) {
      const createdAt = createdAtByOrder.get(it.order_id);
      if (createdAt === undefined) continue; // cancelled, or older than 30 days
      units30 += it.quantity;
      if (createdAt >= since7Ms) units7 += it.quantity;
    }
    return { unitsSoldLast7Days: units7, unitsSoldLast30Days: units30 };
  } catch (err) {
    console.error("[restock-check] velocity query failed for product", productId, err);
    return null;
  }
}

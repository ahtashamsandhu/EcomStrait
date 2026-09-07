import { NextResponse } from "next/server";
import { resolveApproval, type Approval } from "@ecomstrait/ai";
import { createAdminClient } from "@ecomstrait/db/admin";
import { resolveStoreCredentials } from "@/lib/mcp/resolve-store";
import { setShopifyProductPrice, setShopifyProductStatus } from "@/lib/shopify";

/**
 * The one place a write an agent proposed actually executes.
 *
 * A human (or, later, an approvals UI) posts a decision here; on approval,
 * the action is dispatched to the real Shopify function with the
 * agent-proposed payload. Rejecting — or letting it sit pending — leaves
 * the store untouched, which is the entire point of Phase 5
 * (Docs/AI-Native-Migration-Plan.md): the tool the agent calls never writes
 * anything by itself.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("x-admin-secret");
  const expected = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!expected || auth !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { decision, approvedBy } = (await req.json().catch(() => ({}))) as {
    decision?: "approved" | "rejected";
    approvedBy?: string;
  };
  if (decision !== "approved" && decision !== "rejected") {
    return NextResponse.json({ error: "expected { decision: 'approved' | 'rejected' }" }, { status: 400 });
  }

  const approval = await resolveApproval({ approvalId: id, approvedBy: approvedBy ?? "admin", decision });
  if (!approval) {
    return NextResponse.json({ error: "not found, or already resolved" }, { status: 404 });
  }
  if (decision === "rejected") {
    return NextResponse.json({ ok: true, approval, executed: false });
  }

  try {
    const result = await executeApprovedAction(approval);
    return NextResponse.json({ ok: true, approval, executed: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, approval, executed: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/**
 * Dispatch by `action` name — the only place that maps an approved proposal
 * back to a real write. Adding a new write tool means adding a case here,
 * deliberately: an approval executing itself the moment the action name
 * merely exists somewhere would defeat the point of routing it through one
 * reviewable dispatch table.
 */
async function executeApprovedAction(approval: Approval): Promise<unknown> {
  const { action, payload } = approval;

  if (action === "shopify.set_product_price") {
    const { storeId, productGid, price } = payload as { storeId: string; productGid: string; price: number };
    const creds = await resolveStoreCredentials(storeId);
    if (!creds) throw new Error("No connected Shopify store.");
    return setShopifyProductPrice(creds.shop, creds.token, productGid, price);
  }

  if (action === "shopify.set_product_status") {
    const { storeId, productGid, status } = payload as {
      storeId: string;
      productGid: string;
      status: "ACTIVE" | "DRAFT";
    };
    const creds = await resolveStoreCredentials(storeId);
    if (!creds) throw new Error("No connected Shopify store.");
    return setShopifyProductStatus(creds.shop, creds.token, productGid, status);
  }

  if (action === "inventory.restock") {
    const { productId, quantity } = payload as { productId: string; quantity: number };
    return applyRestock(productId, quantity);
  }

  throw new Error(`Unknown action: ${action}`);
}

/**
 * The n8n restock check's proposal, once approved: bump the supplier's
 * stock and log it the same way every other inventory change on the
 * platform already does (`inventory_adjustments`) — a restock is not a
 * special case, it's the same ledger a manual stock edit writes to.
 */
async function applyRestock(productId: string, quantity: number): Promise<{ resultingStock: number }> {
  const client = createAdminClient();
  if (!client) throw new Error("Not configured.");

  const { data: product } = await client.from("products").select("stock").eq("id", productId).single();
  if (!product) throw new Error("Product not found.");

  const resultingStock = product.stock + quantity;

  const { error: updateError } = await client.from("products").update({ stock: resultingStock }).eq("id", productId);
  if (updateError) throw new Error(updateError.message);

  await client.from("inventory_adjustments").insert({
    product_id: productId,
    delta: quantity,
    resulting_stock: resultingStock,
    reason: "AI restock recommendation, approved",
  });

  return { resultingStock };
}

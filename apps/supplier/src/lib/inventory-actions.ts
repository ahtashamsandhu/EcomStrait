"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireApprovedSupplier } from "@/lib/supplier-context";
import { syncProductToStores } from "@/lib/sync-stores";
import { chunk, cleanIds, type BulkResult } from "@/lib/bulk";
import { friendlyError } from "@/lib/errors";

/** Set a product's stock to an absolute value, logging the adjustment. */
export async function setStock(
  productId: string,
  newStock: number,
  reason?: string,
): Promise<{ error?: string }> {
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return ctx;

  if (!Number.isFinite(newStock)) return { error: "Enter a stock number." };
  const stock = Math.min(10_000_000, Math.max(0, Math.trunc(newStock)));
  const { data: prod } = await ctx.supabase
    .from("products")
    .select("stock")
    .eq("id", productId)
    .eq("supplier_id", ctx.supplierId)
    .maybeSingle();
  if (!prod) return { error: "Product not found." };
  if (prod.stock === stock) return {};

  // One statement in the database: the update and its audit row together,
  // under a row lock, so a sale landing at the same moment can't be lost.
  const { error } = await ctx.supabase.rpc("set_product_stock", {
    p_product_id: productId,
    p_stock: stock,
    p_reason: reason ?? "Manual update",
  });
  if (error) return { error: friendlyError(error) };

  // Every Shopify store selling this product holds its own stock number and
  // won't hear about the change otherwise. Runs after the response so the
  // supplier's save stays fast however many stores carry it.
  after(() => syncProductToStores(productId, { stock: true, content: false }));

  revalidatePath("/inventory");
  revalidatePath("/catalog");
  return {};
}

/** Update a product's low-stock threshold. */
export async function setThreshold(
  productId: string,
  threshold: number,
): Promise<{ error?: string }> {
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return ctx;
  const { error } = await ctx.supabase
    .from("products")
    .update({ low_stock_threshold: Math.max(0, Math.trunc(threshold)) })
    .eq("id", productId)
    .eq("supplier_id", ctx.supplierId);
  if (error) return { error: error.message };
  revalidatePath("/inventory");
  return {};
}

/** The success branch of requireApprovedSupplier (client + resolved supplier). */
type SupplierCtx = Extract<Awaited<ReturnType<typeof requireApprovedSupplier>>, { supplierId: string }>;

/**
 * Read the caller's own stock levels for a set of product ids. Rows belonging
 * to another supplier simply don't come back, which is what scopes every bulk
 * stock action below.
 */
async function readStock(
  ctx: SupplierCtx,
  ids: string[],
): Promise<{ rows: { id: string; stock: number }[]; error?: string }> {
  const rows: { id: string; stock: number }[] = [];
  for (const part of chunk(ids)) {
    const { data, error } = await ctx.supabase
      .from("products")
      .select("id, stock")
      .eq("supplier_id", ctx.supplierId)
      .in("id", part);
    if (error) return { rows, error: error.message };
    rows.push(...(data ?? []));
  }
  return { rows };
}

/**
 * Set many products to the same absolute stock level, logging one adjustment
 * per product that actually moved. Products already at the target value are
 * skipped so the history doesn't fill with no-op entries.
 */
export async function bulkSetStock(ids: string[], stock: number): Promise<BulkResult> {
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return { affected: 0, error: ctx.error };

  const targets = cleanIds(ids);
  if (!targets.length) return { affected: 0, error: "Nothing selected." };
  if (!Number.isFinite(stock)) return { affected: 0, error: "Enter a stock number." };
  const next = Math.max(0, Math.trunc(stock));

  const { rows, error: readErr } = await readStock(ctx, targets);
  if (readErr) return { affected: 0, error: readErr };

  const changed = rows.filter((r) => r.stock !== next);
  if (!changed.length) return { affected: 0 };

  let affected = 0;
  for (const c of changed) {
    const { error } = await ctx.supabase.rpc("set_product_stock", {
      p_product_id: c.id,
      p_stock: next,
      p_reason: "Bulk update",
    });
    if (error) return { affected, error: friendlyError(error) };
    affected += 1;
  }

  after(() => syncProductToStores(changed.map((c) => c.id), { stock: true, content: false }));

  revalidatePath("/inventory");
  revalidatePath("/catalog");
  return { affected };
}

/**
 * Add to (or subtract from) many products' stock. Products landing on the same
 * resulting value are updated together, so this costs a handful of queries
 * rather than one per product. Stock floors at zero.
 */
export async function bulkAdjustStock(ids: string[], delta: number): Promise<BulkResult> {
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return { affected: 0, error: ctx.error };

  const targets = cleanIds(ids);
  if (!targets.length) return { affected: 0, error: "Nothing selected." };
  if (!Number.isFinite(delta)) return { affected: 0, error: "Enter an amount." };
  const step = Math.trunc(delta);
  if (step === 0) return { affected: 0, error: "Enter a non-zero amount." };

  const { rows, error: readErr } = await readStock(ctx, targets);
  if (readErr) return { affected: 0, error: readErr };

  // Products already at zero can't go lower — skip them so the audit log
  // doesn't fill with no-op rows.
  const targetsToMove = rows.filter((r) => Math.max(0, r.stock + step) !== r.stock);
  if (!targetsToMove.length) return { affected: 0 };

  const moved: string[] = [];
  for (const r of targetsToMove) {
    const { error } = await ctx.supabase.rpc("adjust_product_stock", {
      p_product_id: r.id,
      p_delta: step,
      p_reason: step > 0 ? `Bulk +${step}` : `Bulk ${step}`,
    });
    if (error) return { affected: moved.length, error: friendlyError(error) };
    moved.push(r.id);
  }

  after(() => syncProductToStores(moved, { stock: true, content: false }));

  revalidatePath("/inventory");
  revalidatePath("/catalog");
  return { affected: moved.length };
}

/** Apply many stock changes at once (batch update). */
export async function batchSetStock(
  updates: { id: string; stock: number }[],
): Promise<{ updated: number; error?: string }> {
  let updated = 0;
  for (const u of updates) {
    const res = await setStock(u.id, u.stock, "Batch update");
    if (res.error) return { updated, error: res.error };
    updated += 1;
  }
  return { updated };
}

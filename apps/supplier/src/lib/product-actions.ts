"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import type { ProductStatus } from "@ecomstrait/db/types";
import { createAdminClient } from "@ecomstrait/db/admin";
import { requireApprovedSupplier } from "@/lib/supplier-context";
import { enrichProduct, type EnrichInput, type Enrichment } from "@/lib/ai";
import { chunk, cleanIds, type BulkResult } from "@/lib/bulk";
import { syncProductToStores } from "@/lib/sync-stores";
import { assertCanAddProduct, assertTokenBudget, recordTokenUsage } from "@/lib/entitlements";
import { friendlyError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { validatePricing } from "@/lib/product-rules";

/** Raw form values (strings from inputs); parsed here into typed columns. */
export type ProductInput = {
  title: string;
  description?: string;
  category?: string;
  sku?: string;
  wholesale_price?: string;
  retail_price?: string;
  map_price?: string;
  stock?: string;
  status?: ProductStatus;
  seo_title?: string;
  seo_description?: string;
  images?: string[];
  sizes?: string;
  material?: string;
  fit_note?: string;
};

function num(v?: string): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Text/list ceilings; price and stock ceilings live in product-rules.ts. */
const MAX_IMAGES = 30;
const MAX_IMPORT_ROWS = 2000;
const LIMITS: Record<string, number> = {
  title: 300,
  description: 20_000,
  category: 120,
  sku: 120,
  seo_title: 300,
  seo_description: 1000,
  sizes: 2000,
  material: 2000,
  fit_note: 2000,
};

/**
 * Validate one product's raw form values. Returns an error message, or null
 * when the row is acceptable. Negative prices used to flow straight into
 * merchant cost and payable maths; unbounded text bloated every storefront
 * that listed the product.
 */
function validateProductInput(input: ProductInput, label = "Product", requirePrices = false): string | null {
  if (!input || typeof input !== "object") return `${label}: invalid input.`;
  if (!input.title?.trim()) return `${label}: a title is required.`;
  for (const [key, max] of Object.entries(LIMITS)) {
    const v = (input as Record<string, unknown>)[key];
    if (v != null && typeof v !== "string") return `${label}: ${key} must be text.`;
    if (typeof v === "string" && v.length > max) return `${label}: ${key} is too long (max ${max} characters).`;
  }
  const pricing = validatePricing(input, { requirePrices, label });
  if (pricing) return pricing;
  if (input.status != null && input.status !== "draft" && input.status !== "published") {
    return `${label}: status must be draft or published.`;
  }
  if (input.images != null) {
    if (!Array.isArray(input.images)) return `${label}: images must be a list.`;
    if (input.images.length > MAX_IMAGES) return `${label}: at most ${MAX_IMAGES} images.`;
    for (const url of input.images) {
      if (typeof url !== "string" || url.length > 2000 || !/^https?:\/\//i.test(url)) {
        return `${label}: each image must be an https URL.`;
      }
    }
  }
  return null;
}

function toRow(input: ProductInput) {
  return {
    title: input.title.trim(),
    description: input.description?.trim() || null,
    category: input.category?.trim() || null,
    sku: input.sku?.trim() || null,
    wholesale_price: num(input.wholesale_price),
    retail_price: num(input.retail_price),
    map_price: num(input.map_price),
    stock: Math.max(0, Math.trunc(num(input.stock) ?? 0)),
    status: input.status ?? "draft",
    seo_title: input.seo_title?.trim() || null,
    seo_description: input.seo_description?.trim() || null,
    images: input.images ?? [],
    sizes: input.sizes?.trim() || null,
    material: input.material?.trim() || null,
    fit_note: input.fit_note?.trim() || null,
  };
}

export async function createProduct(
  input: ProductInput,
): Promise<{ error: string; upgrade?: boolean } | never> {
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return ctx;
  const invalid = validateProductInput(input, "Product", true);
  if (invalid) return { error: invalid };
  const limit = await assertCanAddProduct();
  if (!limit.ok) return limit;
  const row = toRow(input);
  const { data: created, error } = await ctx.supabase
    .from("products")
    .insert({ supplier_id: ctx.supplierId, ...row })
    .select("id")
    .single();
  if (error) return { error: friendlyError(error) };
  // The opening balance belongs in the audit log like every later change.
  if (created && row.stock > 0) {
    await ctx.supabase.from("inventory_adjustments").insert({
      product_id: created.id,
      delta: row.stock,
      resulting_stock: row.stock,
      reason: "Initial stock",
    });
  }
  revalidatePath("/catalog");
  redirect("/catalog");
}

/** Never trust a client-supplied string as a redirect target as-is — must be
 *  a same-app catalog path, or fall back to the plain list. */
function safeReturnTo(raw?: string): string {
  if (raw && raw.startsWith("/catalog") && !raw.startsWith("//")) return raw;
  return "/catalog";
}

export async function updateProduct(
  id: string,
  input: ProductInput,
  returnTo?: string,
): Promise<{ error: string; upgrade?: boolean } | never> {
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return ctx;
  const invalid = validateProductInput(input, "Product", true);
  if (invalid) return { error: invalid };

  // Captured before the write: the price cascade needs to know which listings
  // were still following this product's old price.
  const { data: before } = await ctx.supabase
    .from("products")
    .select("retail_price, stock")
    .eq("id", id)
    .eq("supplier_id", ctx.supplierId)
    .maybeSingle();
  if (!before) return { error: "Product not found." };

  // Stock is not written with the rest of the row: it moves through the
  // audited, row-locked RPC so the inventory log stays complete and a sale
  // landing at the same moment can't be overwritten.
  const { stock, ...fields } = toRow(input);
  const { error } = await ctx.supabase
    .from("products")
    .update(fields)
    .eq("id", id)
    .eq("supplier_id", ctx.supplierId);
  if (error) return { error: friendlyError(error) };
  if (stock !== before.stock) {
    const { error: stockError } = await ctx.supabase.rpc("set_product_stock", {
      p_product_id: id,
      p_stock: stock,
      p_reason: "Edited on product form",
    });
    if (stockError) return { error: friendlyError(stockError) };
  }

  // Custom-website storefronts read this row live, so title and images are
  // already correct there — but their price comes from `store_products`, and
  // Shopify stores hold a full copy that would otherwise stay frozen at
  // whatever it was when the merchant listed it.
  after(() => syncProductToStores(id, { previousPrice: before?.retail_price ?? null }));

  revalidatePath("/catalog");
  redirect(safeReturnTo(returnTo));
}

export async function deleteProduct(id: string): Promise<{ error?: string }> {
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase
    .from("products")
    .delete()
    .eq("id", id)
    .eq("supplier_id", ctx.supplierId);
  if (error) return { error: friendlyError(error) };
  revalidatePath("/catalog");
  return {};
}

export async function setProductStatus(
  id: string,
  status: ProductStatus,
): Promise<{ error?: string }> {
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return { error: ctx.error };
  if (status !== "draft" && status !== "published") return { error: "Invalid status." };
  const { error } = await ctx.supabase
    .from("products")
    .update({ status })
    .eq("id", id)
    .eq("supplier_id", ctx.supplierId);
  if (error) return { error: friendlyError(error) };

  // Unpublishing has to reach the storefronts already selling it, or the
  // product stays buyable on every store that listed it while we consider it
  // withdrawn. Publishing again brings the same listings back.
  after(() => syncProductToStores(id, { status: true, content: false, stock: false }));

  revalidatePath("/catalog");
  return {};
}

/**
 * Publish or unpublish many products at once. Every query is scoped to the
 * caller's supplier, so ids belonging to another supplier are silently skipped
 * rather than trusted — `affected` reflects what actually changed.
 */
export async function bulkSetProductStatus(
  ids: string[],
  status: ProductStatus,
): Promise<BulkResult> {
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return { affected: 0, error: ctx.error };

  const targets = cleanIds(ids);
  if (!targets.length) return { affected: 0, error: "Nothing selected." };
  if (status !== "draft" && status !== "published") return { affected: 0, error: "Invalid status." };

  let affected = 0;
  const changed: string[] = [];
  for (const part of chunk(targets)) {
    const { data, error } = await ctx.supabase
      .from("products")
      .update({ status })
      .eq("supplier_id", ctx.supplierId)
      .in("id", part)
      .select("id");
    if (error) return { affected, error: friendlyError(error) };
    changed.push(...(data ?? []).map((r) => r.id));
    affected += data?.length ?? 0;
  }

  // Same reason as setProductStatus: unpublishing has to reach the storefronts
  // already selling these, or they stay buyable after we've withdrawn them.
  after(() => syncProductToStores(changed, { status: true, content: false, stock: false }));

  revalidatePath("/catalog");
  revalidatePath("/inventory");
  return { affected };
}

/** Delete many products at once. Scoped to the caller's supplier. */
export async function bulkDeleteProducts(ids: string[]): Promise<BulkResult> {
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return { affected: 0, error: ctx.error };

  const targets = cleanIds(ids);
  if (!targets.length) return { affected: 0, error: "Nothing selected." };

  let affected = 0;
  for (const part of chunk(targets)) {
    const { data, error } = await ctx.supabase
      .from("products")
      .delete()
      .eq("supplier_id", ctx.supplierId)
      .in("id", part)
      .select("id");
    if (error) return { affected, error: friendlyError(error) };
    affected += data?.length ?? 0;
  }

  revalidatePath("/catalog");
  revalidatePath("/inventory");
  return { affected };
}

export async function bulkImportProducts(
  rows: ProductInput[],
): Promise<{ imported: number; error?: string; upgrade?: boolean }> {
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return { imported: 0, error: ctx.error };
  if (!Array.isArray(rows)) return { imported: 0, error: "No valid rows found." };
  if (rows.length > MAX_IMPORT_ROWS) {
    return { imported: 0, error: `Import at most ${MAX_IMPORT_ROWS} rows at a time.` };
  }
  const clean = rows.filter((r) => r?.title?.trim());
  if (!clean.length) return { imported: 0, error: "No valid rows found." };
  for (let i = 0; i < clean.length; i++) {
    const invalid = validateProductInput(clean[i], `Row ${i + 1}`);
    if (invalid) return { imported: 0, error: invalid };
  }
  const limit = await assertCanAddProduct(clean.length);
  if (!limit.ok) return { imported: 0, error: limit.error, upgrade: true };
  let imported = 0;
  for (const part of chunk(clean, 200)) {
    const { error, count } = await ctx.supabase
      .from("products")
      .insert(part.map((r) => ({ supplier_id: ctx.supplierId, ...toRow(r) })), { count: "exact" });
    if (error) return { imported, error: friendlyError(error) };
    imported += count ?? part.length;
  }
  revalidatePath("/catalog");
  return { imported };
}

export async function enrichProductAction(
  input: EnrichInput,
): Promise<Enrichment | { error: string; upgrade?: boolean }> {
  // This calls a paid model. It used to run for anyone who could reach the
  // action — no session, no approval, no cap on the prompt, no rate limit.
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return { error: ctx.error };
  const title = String(input?.title ?? "").trim();
  if (!title) return { error: "Enter a product title first." };
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const safeInput: EnrichInput = {
    title: title.slice(0, 300),
    category: text(input.category, 120),
    wholesalePrice:
      typeof input.wholesalePrice === "number" && Number.isFinite(input.wholesalePrice) && input.wholesalePrice >= 0
        ? input.wholesalePrice
        : undefined,
    // Same ceilings as the product columns they come from (LIMITS above),
    // except the draft description, which is capped well below its column
    // limit — it's prompt input, not something to store.
    material: text(input.material, LIMITS.material),
    sizes: text(input.sizes, LIMITS.sizes),
    fitNote: text(input.fitNote, LIMITS.fit_note),
    description: text(input.description, 1500),
  };
  const limited = await rateLimit(`enrich:${ctx.supplierId}`, { limit: 20, windowSeconds: 60 });
  if (!limited.allowed) return { error: "Too many AI requests — try again in a minute." };
  const budget = await assertTokenBudget(500);
  if (!budget.ok) return { error: budget.error, upgrade: true };
  Object.assign(safeInput, await comparablePrices(safeInput.category));
  const result = await enrichProduct(safeInput);
  await recordTokenUsage(result.tokensUsed);
  return result;
}

/**
 * Market context for the enrichment prompt: retail prices of up to 5 other
 * published products in the same category, platform-wide, plus the typical
 * retail ÷ wholesale multiple across them. Retail prices are public (they're
 * shown on storefronts); wholesale prices are not, so those only ever leave
 * here as one aggregate ratio, never per product. Uses the admin client
 * because the supplier's own client can only see its own catalog — without
 * it, comparables are simply omitted.
 */
async function comparablePrices(
  category: string | undefined,
): Promise<Pick<EnrichInput, "comparableRetailPrices" | "comparableRetailMultiple">> {
  const none = { comparableRetailPrices: undefined, comparableRetailMultiple: null };
  if (!category) return none;
  const admin = createAdminClient();
  if (!admin) return none;
  const { data } = await admin
    .from("products")
    .select("retail_price, wholesale_price")
    .eq("status", "published")
    .ilike("category", category)
    .not("retail_price", "is", null)
    .gt("retail_price", 0)
    .order("updated_at", { ascending: false })
    .limit(5);
  const rows = data ?? [];
  if (!rows.length) return none;
  const retail = rows.map((r) => Math.round((r.retail_price as number) * 100) / 100);
  const multiples = rows
    .filter((r) => r.wholesale_price != null && r.wholesale_price > 0)
    .map((r) => (r.retail_price as number) / (r.wholesale_price as number));
  const multiple = multiples.length
    ? Math.round((multiples.reduce((s, m) => s + m, 0) / multiples.length) * 10) / 10
    : null;
  return { comparableRetailPrices: retail, comparableRetailMultiple: multiple };
}

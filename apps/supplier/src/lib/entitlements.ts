import { SUPPLIER_PLAN_ENTITLEMENTS } from "@ecomstrait/db";
import type { PlanTier } from "@ecomstrait/db";
import { getSupplierContext } from "@/lib/supplier-context";
import { ensureSupplierSubscription, effectivePlan } from "@/lib/subscription";

export type SupplierEntitlements = {
  plan: PlanTier;
  tokensPerDay: number;
  productLimit: number | null;
  tokensUsed: number;
  tokensRemaining: number;
  productsUsed: number;
  canAddProduct: boolean;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The caller's plan + live usage (tokens today, catalog size) and derived limits. */
export async function getEntitlements(): Promise<SupplierEntitlements> {
  const sub = await ensureSupplierSubscription();
  const plan = effectivePlan(sub);
  const ent = SUPPLIER_PLAN_ENTITLEMENTS[plan];

  const ctx = await getSupplierContext();

  let tokensUsed = 0;
  let productsUsed = 0;
  if (!("error" in ctx)) {
    const { data: usage } = await ctx.supabase
      .from("supplier_usage_daily")
      .select("tokens_used")
      .eq("supplier_id", ctx.supplierId)
      .eq("day", today())
      .maybeSingle();
    tokensUsed = usage?.tokens_used ?? 0;

    // The whole catalog counts against the limit — draft products included,
    // not just published listings (the limit is catalog size, not just
    // what's currently live).
    const { count } = await ctx.supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("supplier_id", ctx.supplierId);
    productsUsed = count ?? 0;
  }

  return {
    plan,
    tokensPerDay: ent.tokensPerDay,
    productLimit: ent.productLimit,
    tokensUsed,
    tokensRemaining: Math.max(0, ent.tokensPerDay - tokensUsed),
    productsUsed,
    canAddProduct: ent.productLimit === null || productsUsed < ent.productLimit,
  };
}

/** Gate an AI action: fail if today's budget can't cover `estimated` tokens. */
export async function assertTokenBudget(
  estimated = 1,
): Promise<{ ok: true; remaining: number } | { ok: false; error: string; upgrade: true }> {
  const e = await getEntitlements();
  if (e.tokensRemaining <= 0 || e.tokensRemaining < estimated) {
    return {
      ok: false,
      error: `Daily AI limit reached (${e.tokensPerDay.toLocaleString()} tokens/day on ${SUPPLIER_PLAN_ENTITLEMENTS[e.plan].label}). Upgrade for more.`,
      // Callers surface this as an Upgrade popup instead of a plain error.
      upgrade: true,
    };
  }
  return { ok: true, remaining: e.tokensRemaining };
}

/** Record token usage against today's counter (call after an AI action). */
export async function recordTokenUsage(tokens: number): Promise<void> {
  if (tokens <= 0) return;
  const ctx = await getSupplierContext();
  if ("error" in ctx) return;

  // Atomic `tokens_used = tokens_used + n` in the database. The table is
  // read-only for sessions now, so a user can't zero their own counter.
  const { error } = await ctx.supabase.rpc("increment_supplier_token_usage", {
    p_supplier_id: ctx.supplierId,
    p_tokens: Math.round(tokens),
  });
  if (error) console.error("[entitlements] usage increment failed:", error.message);
}

/** Gate adding N more products against the plan's catalog limit. */
export async function assertCanAddProduct(
  count = 1,
): Promise<{ ok: true } | { ok: false; error: string; upgrade: true }> {
  const e = await getEntitlements();
  if (e.productLimit !== null && e.productsUsed + count > e.productLimit) {
    return {
      ok: false,
      error: `You've reached your plan's catalog limit (${e.productLimit} products). Upgrade to add more.`,
      upgrade: true,
    };
  }
  return { ok: true };
}

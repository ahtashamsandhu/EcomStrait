import { createAdminClient } from "@ecomstrait/db/admin";
import type { PlanTier, SupplierSubscription, SubscriptionStatus } from "@ecomstrait/db";
import { getSupplierContext } from "@/lib/supplier-context";
import { getStripe, planForPrice, mapStripeStatus, periodEndIso } from "@/lib/stripe";

/**
 * Supplier-side counterpart of apps/merchant/src/lib/subscription.ts, keyed
 * by `supplierId` (the business) instead of `user_id` — see
 * supabase/migrations/20260901170000_supplier_subscriptions.sql for why.
 *
 * No promo/trial mechanic here (merchant's first-100-users-get-Full-free):
 * not part of what was asked for suppliers, and easy to add later — new
 * supplier subscriptions default straight to free/active.
 */

/** Ensure the caller's supplier business has a subscription row. */
export async function ensureSupplierSubscription(): Promise<SupplierSubscription | null> {
  const ctx = await getSupplierContext();
  if ("error" in ctx) return null;

  const admin = createAdminClient();
  if (!admin) {
    // No service role configured — read-only fallback.
    const { data } = await ctx.supabase
      .from("supplier_subscriptions")
      .select("*")
      .eq("supplier_id", ctx.supplierId)
      .maybeSingle();
    return data ?? null;
  }

  const { data: existing } = await admin
    .from("supplier_subscriptions")
    .select("*")
    .eq("supplier_id", ctx.supplierId)
    .maybeSingle();
  if (existing) return existing;

  const { data } = await admin
    .from("supplier_subscriptions")
    .insert({ supplier_id: ctx.supplierId, plan: "free" as PlanTier, status: "active" as SubscriptionStatus })
    .select("*")
    .single();
  return data ?? null;
}

/**
 * Pull the supplier's live subscription from Stripe and update the row.
 * Called from the Billing page on every load — no webhook dependency for
 * correctness (see apps/merchant/src/lib/subscription.ts's twin for why).
 */
export async function reconcileSupplierSubscription(): Promise<void> {
  const stripe = getStripe();
  if (!stripe) return;

  const ctx = await getSupplierContext();
  if ("error" in ctx) return;

  const admin = createAdminClient();
  if (!admin) return;

  const { data: row } = await admin
    .from("supplier_subscriptions")
    .select("stripe_customer_id")
    .eq("supplier_id", ctx.supplierId)
    .maybeSingle();

  let customerId = row?.stripe_customer_id ?? null;
  // Self-heal: if the customer link is missing, find it by the owner's
  // email and save it.
  if (!customerId) {
    const {
      data: { user },
    } = await ctx.supabase.auth.getUser();
    if (user?.email) {
      const found = await stripe.customers.list({ email: user.email, limit: 1 });
      customerId = found.data[0]?.id ?? null;
      if (customerId) {
        await admin
          .from("supplier_subscriptions")
          .update({ stripe_customer_id: customerId })
          .eq("supplier_id", ctx.supplierId);
      }
    }
  }
  if (!customerId) return;

  const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 3 });
  const active = subs.data.find((s) => s.status === "active" || s.status === "trialing") ?? subs.data[0];

  if (!active) {
    await admin
      .from("supplier_subscriptions")
      .update({ plan: "free", status: "canceled" })
      .eq("supplier_id", ctx.supplierId);
    return;
  }

  const plan = planForPrice(active.items.data[0]?.price.id) ?? "free";
  await admin
    .from("supplier_subscriptions")
    .update({
      plan,
      status: mapStripeStatus(active.status),
      stripe_subscription_id: active.id,
      current_period_end: periodEndIso(active),
    })
    .eq("supplier_id", ctx.supplierId);
}

/** The plan actually in effect (anything but active falls back to Free). */
export function effectivePlan(sub: SupplierSubscription | null): PlanTier {
  if (!sub) return "free";
  if (sub.status === "active") return sub.plan;
  return "free";
}

import { createClient } from "@ecomstrait/auth/server";
import { createAdminClient } from "@ecomstrait/db/admin";
import type { PlanTier, Subscription, SubscriptionStatus } from "@ecomstrait/db";
import { getStripe, planForPrice, mapStripeStatus, periodEndIso } from "@/lib/stripe";

type SubInsert = {
  user_id: string;
  plan: PlanTier;
  status: SubscriptionStatus;
  trial_ends_at?: string;
  promo_eligible: boolean;
};

/**
 * Ensure the current user has a subscription row. Every new signup starts on
 * Free — the first-100-merchants "free FULL month" promo has been retired, so
 * this no longer auto-enrolls anyone into a trialing Full plan. (Existing
 * promo rows created before this change keep working as-is via
 * `effectivePlan`/`inPromoTrial` below; they just aren't handed out anymore.)
 * All subscription writes go through the service role — users can only read
 * theirs.
 */
export async function ensureSubscription(): Promise<Subscription | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const admin = createAdminClient();
  if (!admin) {
    // No service role configured — read-only fallback.
    const { data } = await supabase.from("subscriptions").select("*").eq("user_id", user.id).maybeSingle();
    return data ?? null;
  }

  const { data: existing } = await admin
    .from("subscriptions")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  if (existing) return existing;

  const row: SubInsert = { user_id: user.id, plan: "free", status: "active", promo_eligible: false };

  const { data } = await admin.from("subscriptions").insert(row).select("*").single();
  return data ?? null;
}

/**
 * Pull the user's live subscription from Stripe and update our row. Used instead
 * of a webhook (call it on the Billing page). No-op for users without a Stripe
 * customer (e.g. promo/free users who never checked out).
 */
export async function reconcileSubscription(): Promise<void> {
  const stripe = getStripe();
  if (!stripe) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const admin = createAdminClient();
  if (!admin) return;

  const { data: row } = await admin
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  let customerId = row?.stripe_customer_id ?? null;
  // Self-heal: if the customer link is missing, find it by email and save it.
  if (!customerId && user.email) {
    const found = await stripe.customers.list({ email: user.email, limit: 1 });
    customerId = found.data[0]?.id ?? null;
    if (customerId) {
      await admin.from("subscriptions").update({ stripe_customer_id: customerId }).eq("user_id", user.id);
    }
  }
  if (!customerId) return;

  const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 3 });
  const active = subs.data.find((s) => s.status === "active" || s.status === "trialing") ?? subs.data[0];

  if (!active) {
    await admin.from("subscriptions").update({ plan: "free", status: "canceled" }).eq("user_id", user.id);
    return;
  }

  const plan = planForPrice(active.items.data[0]?.price.id) ?? "free";
  await admin
    .from("subscriptions")
    .update({
      plan,
      status: mapStripeStatus(active.status),
      stripe_subscription_id: active.id,
      current_period_end: periodEndIso(active),
    })
    .eq("user_id", user.id);
}

/** The plan actually in effect (expired trials / canceled subs fall back to Free). */
export function effectivePlan(sub: Subscription | null): PlanTier {
  if (!sub) return "free";
  if (sub.status === "trialing") {
    const active = sub.trial_ends_at ? new Date(sub.trial_ends_at) > new Date() : true;
    return active ? sub.plan : "free";
  }
  if (sub.status === "active") return sub.plan;
  return "free";
}

/** True while a promo trial is still running. */
export function inPromoTrial(sub: Subscription | null): boolean {
  return Boolean(
    sub?.promo_eligible &&
      sub.status === "trialing" &&
      sub.trial_ends_at &&
      new Date(sub.trial_ends_at) > new Date(),
  );
}

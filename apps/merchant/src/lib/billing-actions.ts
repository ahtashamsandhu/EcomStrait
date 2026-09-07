"use server";

import { createClient } from "@ecomstrait/auth/server";
import { createAdminClient } from "@ecomstrait/db/admin";
import type { PlanTier } from "@ecomstrait/db";
import { getStripe, PRICE_IDS, merchantUrl } from "@/lib/stripe";
import { ensureSubscription } from "@/lib/subscription";

export async function createCheckoutSession(
  plan: Exclude<PlanTier, "free">,
): Promise<{ url?: string; error?: string }> {
  const stripe = getStripe();
  const priceId = PRICE_IDS[plan];
  if (!stripe || !priceId) return { error: "Billing isn't configured yet." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { error: "Not authenticated." };

  await ensureSubscription();
  const admin = createAdminClient();

  // Reuse or create the Stripe customer, and persist its id.
  let customerId: string | null = null;
  if (admin) {
    const { data: sub } = await admin
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();
    customerId = sub?.stripe_customer_id ?? null;
  }
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { user_id: user.id },
    });
    customerId = customer.id;
    if (admin) await admin.from("subscriptions").update({ stripe_customer_id: customerId }).eq("user_id", user.id);
  }

  const base = merchantUrl();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${base}/billing?success=1`,
    cancel_url: `${base}/billing?canceled=1`,
    subscription_data: { metadata: { user_id: user.id } },
    metadata: { user_id: user.id, plan },
    allow_promotion_codes: true,
  });

  return { url: session.url ?? undefined };
}

export async function createPortalSession(): Promise<{ url?: string; error?: string }> {
  const stripe = getStripe();
  if (!stripe) return { error: "Billing isn't configured yet." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const admin = createAdminClient();
  const { data: sub } = admin
    ? await admin.from("subscriptions").select("stripe_customer_id").eq("user_id", user.id).maybeSingle()
    : { data: null };
  if (!sub?.stripe_customer_id) return { error: "No billing account yet — subscribe first." };

  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: `${merchantUrl()}/billing`,
  });
  return { url: session.url };
}

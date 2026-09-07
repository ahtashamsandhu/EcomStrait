"use server";

import { createAdminClient } from "@ecomstrait/db/admin";
import type { PlanTier } from "@ecomstrait/db";
import { getStripe, PRICE_IDS, supplierUrl } from "@/lib/stripe";
import { getSupplierContext } from "@/lib/supplier-context";
import { ensureSupplierSubscription } from "@/lib/subscription";

export async function createCheckoutSession(
  plan: Exclude<PlanTier, "free">,
): Promise<{ url?: string; error?: string }> {
  const stripe = getStripe();
  const priceId = PRICE_IDS[plan];
  if (!stripe || !priceId) return { error: "Billing isn't configured yet." };

  const ctx = await getSupplierContext();
  if ("error" in ctx) return ctx;
  if (!ctx.isOwner) return { error: "Only the account owner can change the plan." };

  const {
    data: { user },
  } = await ctx.supabase.auth.getUser();
  if (!user?.email) return { error: "Not authenticated." };

  await ensureSupplierSubscription();
  const admin = createAdminClient();

  // Reuse or create the Stripe customer, and persist its id.
  let customerId: string | null = null;
  if (admin) {
    const { data: sub } = await admin
      .from("supplier_subscriptions")
      .select("stripe_customer_id")
      .eq("supplier_id", ctx.supplierId)
      .maybeSingle();
    customerId = sub?.stripe_customer_id ?? null;
  }
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { supplier_id: ctx.supplierId },
    });
    customerId = customer.id;
    if (admin) {
      await admin
        .from("supplier_subscriptions")
        .update({ stripe_customer_id: customerId })
        .eq("supplier_id", ctx.supplierId);
    }
  }

  const base = supplierUrl();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${base}/billing?success=1`,
    cancel_url: `${base}/billing?canceled=1`,
    subscription_data: { metadata: { supplier_id: ctx.supplierId } },
    metadata: { supplier_id: ctx.supplierId, plan },
    allow_promotion_codes: true,
  });

  return { url: session.url ?? undefined };
}

export async function createPortalSession(): Promise<{ url?: string; error?: string }> {
  const stripe = getStripe();
  if (!stripe) return { error: "Billing isn't configured yet." };

  const ctx = await getSupplierContext();
  if ("error" in ctx) return ctx;
  if (!ctx.isOwner) return { error: "Only the account owner can manage billing." };

  const admin = createAdminClient();
  const { data: sub } = admin
    ? await admin.from("supplier_subscriptions").select("stripe_customer_id").eq("supplier_id", ctx.supplierId).maybeSingle()
    : { data: null };
  if (!sub?.stripe_customer_id) return { error: "No billing account yet — subscribe first." };

  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: `${supplierUrl()}/billing`,
  });
  return { url: session.url };
}

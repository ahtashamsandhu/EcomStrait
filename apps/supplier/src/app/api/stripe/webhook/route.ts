import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { createAdminClient } from "@ecomstrait/db/admin";
import { creditWallet, releaseHeldOrders } from "@ecomstrait/db/wallet";
import { getStripe, planForPrice, mapStripeStatus, periodEndIso } from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * Credits a supplier's wallet once their top-up Checkout session completes,
 * and keeps `supplier_subscriptions` in sync with Stripe. Optional for
 * subscriptions — the Billing page reconciles from Stripe on load
 * (reconcileSupplierSubscription) — but wallet top-ups depend on this (plus
 * the wallet page's own reconciliation fallback for when this doesn't fire).
 */
export async function POST(req: Request) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers.get("stripe-signature");
  if (!stripe || !secret || !sig) return NextResponse.json({ ok: false }, { status: 400 });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: true });

  async function apply(subscriptionId: string, customerId: string) {
    const sub = await stripe!.subscriptions.retrieve(subscriptionId);
    await admin!
      .from("supplier_subscriptions")
      .update({
        plan: planForPrice(sub.items.data[0]?.price.id) ?? "free",
        status: mapStripeStatus(sub.status),
        stripe_subscription_id: sub.id,
        current_period_end: periodEndIso(sub),
      })
      .eq("stripe_customer_id", customerId);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      // Delayed payment methods complete the session before the money lands.
      if (s.payment_status !== "paid") break;
      if (s.metadata?.purpose === "wallet_topup" && s.metadata.supplier_id && s.amount_total) {
        const amount = s.amount_total / 100;
        await creditWallet(admin, amount, {
          accountType: "supplier",
          accountId: s.metadata.supplier_id,
          kind: "topup",
          note: `Stripe checkout ${s.id}`,
          // A redelivered webhook, or a race against the wallet page's own
          // reconciliation fallback for this same session, must credit the
          // wallet at most once — enforced by wallet_adjust's unique index,
          // not left to chance.
          externalRef: s.id,
        });
        await releaseHeldOrders(admin, "supplier", s.metadata.supplier_id);
        break;
      }
      if (s.subscription && s.customer) await apply(String(s.subscription), String(s.customer));
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      await apply(sub.id, String(sub.customer));
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await admin
        .from("supplier_subscriptions")
        .update({ plan: "free", status: "canceled" })
        .eq("stripe_customer_id", String(sub.customer));
      break;
    }
  }

  return NextResponse.json({ ok: true });
}

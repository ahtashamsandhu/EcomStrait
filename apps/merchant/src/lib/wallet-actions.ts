"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@ecomstrait/auth/server";
import { createAdminClient } from "@ecomstrait/db/admin";
import { creditWallet, releaseHeldOrders } from "@ecomstrait/db/wallet";
import { getStripe, merchantUrl } from "@/lib/stripe";

/**
 * Creates a Stripe Checkout session that credits the caller's merchant
 * wallet once it completes (Docs/Credits-Settlement-Plan.md). Crediting
 * itself happens in the Stripe webhook (checkout.session.completed,
 * metadata.purpose === "wallet_topup"), not here — this action never
 * touches the wallet directly.
 */
export async function createWalletTopupSession(amount: number): Promise<{ url?: string; error?: string }> {
  if (!Number.isFinite(amount) || amount < 1) {
    return { error: "Enter an amount of at least $1." };
  }

  const stripe = getStripe();
  if (!stripe) return { error: "Wallet top-up isn't available right now." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const base = merchantUrl();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          product_data: { name: "EcomStrait wallet top-up" },
          unit_amount: Math.round(amount * 100),
        },
      },
    ],
    success_url: `${base}/wallet?topup=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/wallet?topup=cancelled`,
    metadata: { purpose: "wallet_topup", account_type: "merchant", user_id: user.id },
  });

  return { url: session.url ?? undefined };
}

/**
 * Self-heal fallback for the wallet top-up flow (mirrors reconcileSubscription
 * in subscription.ts): a Checkout session completing and the Stripe webhook
 * firing are two independent things, so landing back on /wallet after a
 * successful payment doesn't guarantee `checkout.session.completed` actually
 * reached and was applied by /api/stripe/webhook (missing/misconfigured
 * STRIPE_WEBHOOK_SECRET, a failed delivery, etc). Called from the wallet page
 * whenever it loads with ?topup=success&session_id=..., verifying payment
 * directly with Stripe. Idempotent against the webhook via `externalRef` —
 * wallet_adjust's unique index guarantees this session is credited at most
 * once no matter which of the two runs first, or whether they race.
 */
export async function reconcileWalletTopup(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const stripe = getStripe();
  if (!stripe) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const admin = createAdminClient();
  if (!admin) return;

  const session = await stripe.checkout.sessions.retrieve(sessionId).catch(() => null);
  if (
    !session ||
    session.payment_status !== "paid" ||
    session.metadata?.purpose !== "wallet_topup" ||
    session.metadata.user_id !== user.id ||
    !session.amount_total
  ) {
    return;
  }

  await creditWallet(admin, session.amount_total / 100, {
    accountType: "merchant",
    accountId: user.id,
    kind: "topup",
    note: `Stripe checkout ${session.id}`,
    externalRef: session.id,
  });
  await releaseHeldOrders(admin, "merchant", user.id);
}

/**
 * Withdraw request: the merchant picks an amount (up to their current
 * pending payable balance) and gives a bank account. An admin processes it
 * manually by bank transfer — outside this app — and uploads a receipt once
 * done (see settlement-actions.ts's markPayoutRequestPaid). Doesn't move
 * money itself. Refuses a second open request while one is already pending,
 * and refuses an amount over what's actually owed.
 *
 * The specific `payable_ledger` rows being cashed out (oldest first, up to
 * the requested amount) are locked to this request right here — not just a
 * number on the payout_requests row — so "Pending payout" on the wallet page
 * actually drops once it's paid, and the same money can't also get swept
 * into a separate weekly settlement batch in the meantime. Each row is tied
 * to one order, so the amount actually withdrawn can end up a little more
 * than what was typed (whatever fully covers it) — the returned `amount` is
 * the real figure to show back.
 */
export async function requestPayout(input: {
  amount: number;
  bankAccountName: string;
  bankName: string;
  bankAccountNumber: string;
  bankRoutingCode?: string;
  note?: string;
}): Promise<{ error?: string; amount?: number }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const requested = Number(input.amount);
  if (!Number.isFinite(requested) || requested <= 0) return { error: "Enter a withdrawal amount." };

  const bankAccountName = input.bankAccountName.trim();
  const bankName = input.bankName.trim();
  const bankAccountNumber = input.bankAccountNumber.trim();
  if (!bankAccountName || !bankName || !bankAccountNumber) {
    return { error: "Account holder name, bank name, and account number are all required." };
  }

  // Everything below happens in one database transaction: the "one pending
  // request" check, the available-balance sum, the insert and the earmarking
  // of the exact ledger rows it covers. Doing it here in steps let two
  // simultaneous submissions both pass the checks and both earmark the same
  // money, and a direct PostgREST insert skipped the checks entirely.
  const { data, error } = await supabase.rpc("request_payout", {
    p_account_type: "merchant",
    p_amount: requested,
    p_bank_account_name: bankAccountName,
    p_bank_name: bankName,
    p_bank_account_number: bankAccountNumber,
    p_bank_routing_code: input.bankRoutingCode?.trim() || null,
    p_note: input.note?.trim() || null,
  });
  if (error) {
    // Our function raises plain-English messages; anything else is internal.
    const internal = /violates|relation|column|constraint|permission denied/i.test(error.message);
    if (internal) console.error("[wallet] request_payout failed:", error);
    return { error: internal ? "Couldn't submit the request." : error.message };
  }
  const row = Array.isArray(data) ? data[0] : null;

  revalidatePath("/wallet");
  return { amount: row ? Number(row.amount) : requested };
}

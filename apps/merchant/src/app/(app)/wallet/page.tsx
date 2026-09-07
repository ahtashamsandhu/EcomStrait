import type { Metadata } from "next";
import { Wallet as WalletIcon, Clock, HandCoins, ArrowUpRight, ArrowDownLeft, Receipt } from "lucide-react";
import { cn } from "@ecomstrait/ui";
import { createClient } from "@ecomstrait/auth/server";
import { createAdminClient } from "@ecomstrait/db/admin";
import { getWalletBalance } from "@ecomstrait/db/wallet";
import type { WalletTransactionKind, PayoutRequestStatus } from "@ecomstrait/db";
import { WalletTopupForm } from "@/components/wallet/topup-form";
import { WithdrawalForm } from "@/components/wallet/withdrawal-form";
import { reconcileWalletTopup } from "@/lib/wallet-actions";

export const metadata: Metadata = { title: "Wallet" };

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const KIND_LABEL: Record<WalletTransactionKind, string> = {
  topup: "Top-up",
  order_deduction: "Order deduction",
  order_credit: "Order credit",
  reversal: "Refund",
  settlement_payout: "Settlement payout",
};
const KIND_STYLE: Record<WalletTransactionKind, string> = {
  topup: "bg-brand-50 text-brand-700",
  order_deduction: "bg-ink-100 text-ink-500",
  order_credit: "bg-brand-50 text-brand-700",
  reversal: "bg-amber-50 text-amber-700",
  settlement_payout: "bg-brand-50 text-brand-700",
};

const WITHDRAWAL_STATUS_LABEL: Record<PayoutRequestStatus, string> = {
  pending: "Pending review",
  paid: "Paid",
  declined: "Declined",
};
const WITHDRAWAL_STATUS_STYLE: Record<PayoutRequestStatus, string> = {
  pending: "bg-amber-50 text-amber-700",
  paid: "bg-brand-50 text-brand-700",
  declined: "bg-red-50 text-red-700",
};

export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<{ topup?: string; session_id?: string }>;
}) {
  const { topup, session_id } = await searchParams;
  if (topup === "success" && session_id) {
    // Best-effort: if the Stripe webhook already credited this session this
    // is a no-op, and the page must still render even if Stripe can't be
    // reached right now.
    await reconcileWalletTopup(session_id).catch(() => {});
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const admin = createAdminClient();
  const balance = admin && user ? await getWalletBalance(admin, "merchant", user.id) : 0;

  // Pending payout (Docs/Credits-Settlement-Plan.md §4): what EcomStrait now
  // owes this merchant — the margin on COD orders already realized — that
  // hasn't gone out in a settlement batch yet. Separate from the balance
  // above, which is pre-funded money waiting to be spent, not money owed.
  // `payable_ledger` has a merchant-scoped RLS policy, so this reads via the
  // session client, no admin needed.
  const { data: pendingRows } = user
    ? await supabase
        .from("payable_ledger")
        .select("amount")
        .eq("account_type", "merchant")
        .eq("account_id", user.id)
        .eq("status", "pending")
    : { data: [] };
  const pendingPayout = (pendingRows ?? []).reduce((s, p) => s + p.amount, 0);

  // Withdrawal requests — this merchant's own history, newest first.
  // `payout_requests` is RLS-scoped to its owner, no admin needed to read.
  const { data: withdrawalRows } = user
    ? await supabase
        .from("payout_requests")
        .select("id, amount, status, note, admin_note, receipt_path, requested_at, reviewed_at")
        .eq("account_type", "merchant")
        .eq("account_id", user.id)
        .order("requested_at", { ascending: false })
    : { data: [] };
  const withdrawals = withdrawalRows ?? [];
  const openRequest = withdrawals.find((w) => w.status === "pending") ?? null;

  // A receipt is only ever a storage path (the bucket is private) — resolve
  // each one to a short-lived signed URL to actually render a link.
  const receiptUrlById = new Map<string, string>();
  await Promise.all(
    withdrawals
      .filter((w) => w.receipt_path)
      .map(async (w) => {
        const { data } = await supabase.storage.from("payout-receipts").createSignedUrl(w.receipt_path!, 3600);
        if (data?.signedUrl) receiptUrlById.set(w.id, data.signedUrl);
      }),
  );

  // Transaction ledger — the append-only record of everything that's moved
  // this wallet's balance (top-ups, order deductions, refunds). Also RLS-
  // scoped to this merchant, no admin needed.
  const { data: transactions } = user
    ? await supabase
        .from("wallet_transactions")
        .select("id, kind, amount, balance_after, note, order_id, created_at")
        .eq("account_type", "merchant")
        .eq("account_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50)
    : { data: [] };
  const txns = transactions ?? [];

  // Held orders (Docs/Credits-Settlement-Plan.md): a prepaid order this
  // wallet couldn't cover, still parked in `orders` and invisible to its
  // supplier until a top-up releases it. `orders` has no merchant-facing RLS
  // policy (it's scoped to suppliers), so this reads via the admin client,
  // explicitly filtered to stores this signed-in user actually owns.
  let held: { id: string; number: number; store_name: string | null; cost_amount: number | null; platform_fee_amount: number | null; created_at: string }[] = [];
  if (admin && user) {
    const { data: stores } = await admin.from("stores").select("id").eq("user_id", user.id);
    const storeIds = (stores ?? []).map((s) => s.id);
    if (storeIds.length) {
      const { data } = await admin
        .from("orders")
        .select("id, number, store_name, cost_amount, platform_fee_amount, created_at")
        .in("store_id", storeIds)
        .eq("credit_status", "awaiting_merchant_credits")
        .order("created_at", { ascending: true });
      held = data ?? [];
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold text-ink-950">Wallet</h1>
      <p className="mt-1 text-sm text-ink-500">
        Covers what you owe suppliers on each sale — their cost plus the EcomStrait platform fee.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="flex items-center gap-4 rounded-2xl border border-ink-100 bg-white p-6">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-600">
            <WalletIcon className="h-6 w-6" />
          </span>
          <div>
            <p className="text-xs text-ink-500">Current balance</p>
            <p className="text-2xl font-bold text-ink-950">{money(balance)}</p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-ink-100 bg-white p-6">
          <div className="flex items-center gap-4">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-amber-50 text-amber-600">
              <HandCoins className="h-6 w-6" />
            </span>
            <div>
              <p className="text-xs text-ink-500">Available to withdraw</p>
              <p className="text-2xl font-bold text-ink-950">{money(pendingPayout)}</p>
              <p className="text-[11px] text-ink-400">Margin earned on completed COD orders</p>
            </div>
          </div>
          {openRequest ? (
            <p className="text-xs font-medium text-brand-700">
              {money(openRequest.amount)} requested — an admin will review it.
            </p>
          ) : (
            <WithdrawalForm pendingPayout={pendingPayout} />
          )}
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-ink-100 bg-white p-6">
        <h2 className="text-sm font-semibold text-ink-800">Add credits</h2>
        <div className="mt-3">
          <WalletTopupForm />
        </div>
      </div>

      {withdrawals.length > 0 && (
        <div className="mt-6 rounded-2xl border border-ink-100 bg-white p-6">
          <h2 className="text-sm font-semibold text-ink-800">Withdrawal requests</h2>
          <ul className="mt-3 divide-y divide-ink-50">
            {withdrawals.map((w) => (
              <li key={w.id} className="py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-ink-900">{money(w.amount)}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", WITHDRAWAL_STATUS_STYLE[w.status])}>
                    {WITHDRAWAL_STATUS_LABEL[w.status]}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-ink-400">
                  Requested {when(w.requested_at)}
                  {w.reviewed_at && ` · Reviewed ${when(w.reviewed_at)}`}
                </p>
                {w.admin_note && <p className="mt-1 text-xs text-ink-600">{w.admin_note}</p>}
                {w.status === "paid" && receiptUrlById.has(w.id) && (
                  <a
                    href={receiptUrlById.get(w.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline"
                  >
                    <Receipt className="h-3.5 w-3.5" /> View receipt
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {held.length > 0 && (
        <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/60 p-6">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-600" />
            <h2 className="text-sm font-semibold text-ink-800">
              {held.length} order{held.length === 1 ? "" : "s"} — unpaid / low credits
            </h2>
          </div>
          <p className="mt-1 text-sm text-ink-600">
            Your balance doesn&apos;t cover these yet, so they haven&apos;t been sent to their
            suppliers. Add credits above to release them.
          </p>
          <ul className="mt-4 divide-y divide-amber-100">
            {held.map((o) => (
              <li key={o.id} className="flex items-center justify-between py-2 text-sm">
                <span className="text-ink-700">
                  Order #{o.number} — {o.store_name ?? "Store"} · {when(o.created_at)}
                </span>
                <span className="font-medium text-ink-900">
                  {money((o.cost_amount ?? 0) + (o.platform_fee_amount ?? 0))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 rounded-2xl border border-ink-100 bg-white p-6">
        <h2 className="text-sm font-semibold text-ink-800">Transaction history</h2>
        {txns.length === 0 ? (
          <p className="mt-3 text-sm text-ink-500">Nothing yet — top-ups and order deductions will show up here.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-ink-100 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Type</th>
                  <th className="py-2 pr-4">Note</th>
                  <th className="py-2 pr-4 text-right">Amount</th>
                  <th className="py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.id} className="border-b border-ink-50 last:border-0">
                    <td className="py-2.5 pr-4 text-ink-500">{when(t.created_at)}</td>
                    <td className="py-2.5 pr-4">
                      <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", KIND_STYLE[t.kind])}>
                        {KIND_LABEL[t.kind]}
                      </span>
                    </td>
                    <td className="max-w-[16rem] truncate py-2.5 pr-4 text-ink-500" title={t.note ?? undefined}>
                      {t.note ?? "—"}
                    </td>
                    <td
                      className={cn(
                        "py-2.5 pr-4 text-right font-semibold",
                        t.amount >= 0 ? "text-brand-700" : "text-ink-900",
                      )}
                    >
                      <span className="inline-flex items-center gap-1">
                        {t.amount >= 0 ? (
                          <ArrowDownLeft className="h-3 w-3" />
                        ) : (
                          <ArrowUpRight className="h-3 w-3 text-ink-400" />
                        )}
                        {t.amount >= 0 ? "+" : "−"}
                        {money(Math.abs(t.amount))}
                      </span>
                    </td>
                    <td className="py-2.5 text-right text-ink-500">{money(t.balance_after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

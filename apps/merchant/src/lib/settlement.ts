import "server-only";
import { createAdminClient } from "@ecomstrait/db/admin";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

/**
 * Weekly settlement (Docs/Credits-Settlement-Plan.md, §4 — manual MVP per §1
 * open decision #3).
 *
 * Totals every `payable_ledger` row still pending into one batch and marks
 * them settled. Deliberately does NOT touch wallet balances or
 * `wallet_transactions` — this pays out money EcomStrait collected on
 * someone's behalf and now owes them (the `payable_ledger`), which is
 * separate from a wallet's pre-funded balance. The actual payout is manual
 * for now: this just produces the batch total for an admin to review and pay
 * by bank transfer, then mark paid via `markSettlementBatchPaid`.
 *
 * Excludes any row an admin has put on hold (`held = true`, set via
 * `holdAccountPayables` in settlement-actions.ts) — that account's pending
 * balance stays untouched, in this batch and every later one, until an admin
 * releases it.
 */
export async function runWeeklySettlement(admin: Admin): Promise<{ batchId: string | null; count: number }> {
  const { data: pending } = await admin
    .from("payable_ledger")
    .select("id, account_type, amount")
    .eq("status", "pending")
    .eq("held", false);

  if (!pending || pending.length === 0) return { batchId: null, count: 0 };

  const totalToMerchants = pending
    .filter((p) => p.account_type === "merchant")
    .reduce((s, p) => s + p.amount, 0);
  const totalToSuppliers = pending
    .filter((p) => p.account_type === "supplier")
    .reduce((s, p) => s + p.amount, 0);

  // Period start is the previous batch's end, or 7 days back for the first
  // run ever — either way this is just a label on the batch, not a filter:
  // every currently-pending row is included regardless of when it accrued.
  const { data: lastBatch } = await admin
    .from("settlement_batches")
    .select("period_end")
    .order("run_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const periodStart = lastBatch?.period_end ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
  const periodEnd = new Date().toISOString();

  const { data: batch, error } = await admin
    .from("settlement_batches")
    .insert({
      period_start: periodStart,
      period_end: periodEnd,
      total_to_merchants: totalToMerchants,
      total_to_suppliers: totalToSuppliers,
    })
    .select("id")
    .single();
  if (error || !batch) return { batchId: null, count: 0 };

  await admin
    .from("payable_ledger")
    .update({ status: "settled", settlement_batch_id: batch.id })
    .in(
      "id",
      pending.map((p) => p.id),
    );

  return { batchId: batch.id, count: pending.length };
}

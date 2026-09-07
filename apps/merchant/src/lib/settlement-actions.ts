"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@ecomstrait/auth/server";
import { createAdminClient } from "@ecomstrait/db/admin";
import type { WalletAccountType } from "@ecomstrait/db";
import { settlePayoutRequestLedger, releasePayoutRequestLedger } from "@ecomstrait/db/wallet";
import { runWeeklySettlement } from "@/lib/settlement";

/** Resolves the caller's Supabase session + confirms they're an admin, or an error. Shared by every action below. */
async function requireAdmin(): Promise<
  | { supabase: Awaited<ReturnType<typeof createClient>>; admin: NonNullable<ReturnType<typeof createAdminClient>>; userId: string }
  | { error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (!isAdmin) return { error: "Admin only." };

  const admin = createAdminClient();
  if (!admin) return { error: "Database isn't configured." };

  return { supabase, admin, userId: user.id };
}

/** Marks a settlement batch as paid (manual MVP — Docs/Credits-Settlement-Plan.md §4). */
export async function markSettlementBatchPaid(batchId: string): Promise<{ error?: string }> {
  const ctx = await requireAdmin();
  if ("error" in ctx) return ctx;

  const { error } = await ctx.admin
    .from("settlement_batches")
    .update({ status: "paid", paid_at: new Date().toISOString(), paid_by: ctx.userId })
    .eq("id", batchId);
  if (error) return { error: error.message };

  revalidatePath("/admin/settlements");
  return {};
}

/**
 * Manual trigger for the same batching logic the weekly cron runs
 * (`/api/cron/settlement`) — lets an admin settle on demand (e.g. right
 * after releasing a hold) instead of waiting for the next scheduled run.
 */
export async function runSettlementNow(): Promise<{ error?: string; count?: number }> {
  const ctx = await requireAdmin();
  if ("error" in ctx) return ctx;

  const { count } = await runWeeklySettlement(ctx.admin);
  revalidatePath("/admin/settlements");
  return { count };
}

/**
 * Puts every currently-pending, not-already-earmarked `payable_ledger` row
 * for one account on hold — excluded from `runWeeklySettlement` (this batch
 * and every later one) until `releaseAccountPayables` clears it. Independent
 * of any `payout_requests` row; an admin can hold an account that never
 * asked for early payout at all. Rows already locked to an open withdrawal
 * request (`payout_request_id` set) are left alone — this is a coarser,
 * account-wide hold and must never touch what a specific request already
 * claimed, or releasing it later would silently free rows the withdrawal
 * flow still expects to settle by itself.
 */
export async function holdAccountPayables(
  accountType: WalletAccountType,
  accountId: string,
): Promise<{ error?: string }> {
  const ctx = await requireAdmin();
  if ("error" in ctx) return ctx;

  const { error } = await ctx.admin
    .from("payable_ledger")
    .update({ held: true })
    .eq("account_type", accountType)
    .eq("account_id", accountId)
    .eq("status", "pending")
    .is("payout_request_id", null);
  if (error) return { error: error.message };

  revalidatePath("/admin/settlements");
  return {};
}

/** Clears a hold set by `holdAccountPayables`, making this account's pending balance eligible for settlement again. */
export async function releaseAccountPayables(
  accountType: WalletAccountType,
  accountId: string,
): Promise<{ error?: string }> {
  const ctx = await requireAdmin();
  if ("error" in ctx) return ctx;

  const { error } = await ctx.admin
    .from("payable_ledger")
    .update({ held: false })
    .eq("account_type", accountType)
    .eq("account_id", accountId)
    .eq("status", "pending")
    .is("payout_request_id", null);
  if (error) return { error: error.message };

  revalidatePath("/admin/settlements");
  return {};
}

/**
 * Marks a withdrawal request paid, once an admin has actually sent the money
 * by bank transfer outside this app. `receiptPath` is a path the admin's own
 * browser already uploaded directly to the private `payout-receipts` bucket
 * (same client-side-upload pattern as the avatar uploader) — this action
 * only records it, it never touches file bytes itself.
 *
 * Also settles the specific `payable_ledger` rows requestPayout earmarked
 * for this request (`status -> 'paid_out'`) — without this, "Pending
 * payout" on the wallet page would never reflect a completed withdrawal,
 * and those rows would still be there for the next `runWeeklySettlement` to
 * (wrongly) pay out a second time.
 */
export async function markPayoutRequestPaid(
  requestId: string,
  receiptPath: string,
  adminNote?: string,
): Promise<{ error?: string }> {
  const ctx = await requireAdmin();
  if ("error" in ctx) return ctx;
  if (!receiptPath) return { error: "A receipt is required." };

  const { error } = await ctx.admin
    .from("payout_requests")
    .update({
      status: "paid",
      receipt_path: receiptPath,
      admin_note: adminNote?.trim() || null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: ctx.userId,
    })
    .eq("id", requestId);
  if (error) return { error: error.message };

  await settlePayoutRequestLedger(ctx.admin, requestId);

  revalidatePath("/admin/settlements");
  revalidatePath("/wallet");
  return {};
}

/**
 * Declines a withdrawal request (e.g. bad bank details) — `adminNote` is
 * shown to the requester as the reason. Also releases the `payable_ledger`
 * rows requestPayout earmarked for it, back into the normal pending pool —
 * otherwise they'd stay held forever, invisible to both a future withdrawal
 * request and the weekly settlement.
 */
export async function declinePayoutRequest(requestId: string, adminNote?: string): Promise<{ error?: string }> {
  const ctx = await requireAdmin();
  if ("error" in ctx) return ctx;

  const { error } = await ctx.admin
    .from("payout_requests")
    .update({
      status: "declined",
      admin_note: adminNote?.trim() || null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: ctx.userId,
    })
    .eq("id", requestId);
  if (error) return { error: error.message };

  await releasePayoutRequestLedger(ctx.admin, requestId);

  revalidatePath("/admin/settlements");
  revalidatePath("/wallet");
  return {};
}

"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@ecomstrait/auth/server";
import { createAdminClient } from "@ecomstrait/db/admin";
import { getSupplierContext } from "@/lib/supplier-context";
import { sendStoreOwnerEmail, escapeHtml } from "@/lib/notify";

const MAX_OPEN_INVITES = 20;

/** Link pending staff invitations addressed to the signed-in user's email. */
export async function claimInvites(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return;
  // The invite was addressed to an email; only an account that has proven
  // it owns that address may take the seat. With confirmations switched off
  // in Supabase, anyone could sign up as the invitee's address and join.
  if (!user.email_confirmed_at) return;
  const admin = createAdminClient();
  if (!admin) return;
  await admin
    .from("supplier_members")
    .update({ user_id: user.id, status: "active" })
    .eq("invited_email", user.email.toLowerCase())
    .is("user_id", null)
    .eq("status", "invited");
}

/** Owner invites a teammate by email. */
export async function inviteMember(email: string): Promise<{ error?: string }> {
  const ctx = await getSupplierContext();
  if ("error" in ctx) return ctx;
  if (!ctx.isOwner) return { error: "Only the owner can manage the team." };

  const clean = email.trim().toLowerCase();
  if (!clean.includes("@") || clean.length > 254) return { error: "Enter a valid email." };

  // Each invite sends an email to an address the caller typed; cap how many
  // can sit open so the form can't be used as a mail cannon.
  const { count } = await ctx.supabase
    .from("supplier_members")
    .select("id", { count: "exact", head: true })
    .eq("supplier_id", ctx.supplierId)
    .eq("status", "invited");
  if ((count ?? 0) >= MAX_OPEN_INVITES) {
    return { error: `You have ${MAX_OPEN_INVITES} invitations waiting already — revoke one first.` };
  }

  const { error } = await ctx.supabase
    .from("supplier_members")
    .upsert(
      { supplier_id: ctx.supplierId, invited_email: clean, role: "supplier_staff", status: "invited" },
      { onConflict: "supplier_id,invited_email", ignoreDuplicates: true },
    );
  if (error) return { error: error.message };

  await sendStoreOwnerEmail({
    to: clean,
    subject: "You've been invited to an EcomStrait supplier team",
    html: `<p>You've been invited to join a supplier team on EcomStrait.</p><p>Sign in or create an account with <strong>${escapeHtml(clean)}</strong> and you'll be added automatically.</p>`,
  });

  revalidatePath("/settings", "layout");
  return {};
}

/** Owner removes a teammate (or revokes an invite). */
export async function removeMember(id: string): Promise<{ error?: string }> {
  const ctx = await getSupplierContext();
  if ("error" in ctx) return ctx;
  if (!ctx.isOwner) return { error: "Only the owner can manage the team." };

  const { error } = await ctx.supabase
    .from("supplier_members")
    .delete()
    .eq("id", id)
    .eq("supplier_id", ctx.supplierId);
  if (error) return { error: error.message };

  revalidatePath("/settings", "layout");
  return {};
}

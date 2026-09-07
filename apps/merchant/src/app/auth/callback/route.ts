import { NextResponse } from "next/server";
import { createClient } from "@ecomstrait/auth/server";
import { safeNextPath } from "@ecomstrait/auth/redirect";
import { createAdminClient } from "@ecomstrait/db/admin";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      if (data.user) await ensureMerchantRole(data.user.id);
      return NextResponse.redirect(`${origin}${next}`);
    }
  }
  return NextResponse.redirect(`${origin}/login?error=auth`);
}

/**
 * OAuth sign-ups carry no `role` metadata, so `handle_new_user` gives them
 * the platform default (`supplier`). Someone who signed in through the
 * merchant app and owns no supplier business is a merchant: give them the
 * `business_owner` role, which is what the stores INSERT policy requires.
 * Never touches an account that already runs a supplier, or any privileged
 * role — this is only the OAuth counterpart of the email signup form's
 * `role: "business_owner"` metadata.
 */
async function ensureMerchantRole(userId: string): Promise<void> {
  const admin = createAdminClient();
  if (!admin) return;
  const { data: profile } = await admin.from("profiles").select("role").eq("user_id", userId).maybeSingle();
  if (profile?.role !== "supplier") return;
  const { data: supplier } = await admin.from("suppliers").select("id").eq("owner_user_id", userId).maybeSingle();
  if (supplier) return;
  await admin.from("profiles").update({ role: "business_owner" }).eq("user_id", userId);
}

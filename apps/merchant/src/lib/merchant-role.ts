import "server-only";
import { createAdminClient } from "@ecomstrait/db/admin";

/**
 * Make sure an account using the merchant app carries the `business_owner`
 * role, which creating a store requires (stores_owner_insert policy).
 *
 * The email signup form sends that role as metadata, but a Google sign-up
 * carries none and `handle_new_user` falls back to the platform default
 * (`supplier`); accounts created before the role gate existed can be in the
 * same state. Runs on every merchant page load — one indexed read, and a
 * write only when the role is actually wrong. Never touches an account that
 * runs a supplier business or holds a privileged role.
 */
export async function ensureMerchantRole(userId: string): Promise<void> {
  const admin = createAdminClient();
  if (!admin) return;
  const { data: profile } = await admin.from("profiles").select("role").eq("user_id", userId).maybeSingle();
  if (!profile || (profile.role !== "supplier" && profile.role !== "customer")) return;
  const { data: supplier } = await admin.from("suppliers").select("id").eq("owner_user_id", userId).maybeSingle();
  if (supplier) return;
  const { error } = await admin.from("profiles").update({ role: "business_owner" }).eq("user_id", userId);
  if (error) console.error("[merchant-role] could not promote account:", error.message);
}

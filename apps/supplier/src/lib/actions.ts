"use server";

import { redirect } from "next/navigation";
import {
  createClient,
  requestPasswordReset as requestReset,
  type PasswordResetResult,
} from "@ecomstrait/auth/server";
import { siteUrl } from "@/lib/site-url";

/** Forgot-password: sends the reset email only if the address is on file. */
export async function requestPasswordReset(email: string): Promise<PasswordResetResult> {
  return requestReset(email, siteUrl());
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function signOutAdmin() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/admin/login");
}

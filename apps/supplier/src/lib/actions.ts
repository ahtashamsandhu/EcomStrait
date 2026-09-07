"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  createClient,
  requestPasswordReset as requestReset,
  type PasswordResetResult,
} from "@ecomstrait/auth/server";
import { PW_RESET_PENDING_COOKIE } from "@ecomstrait/auth/middleware";
import { siteUrl } from "@/lib/site-url";

/** Forgot-password: sends the reset email only if the address is on file. */
export async function requestPasswordReset(email: string): Promise<PasswordResetResult> {
  return requestReset(email, siteUrl());
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  (await cookies()).delete(PW_RESET_PENDING_COOKIE);
  redirect("/login");
}

/**
 * Called once `updateUser({ password })` actually succeeds on
 * /reset-password — see PW_RESET_PENDING_COOKIE's doc comment
 * (packages/auth/src/middleware.ts). The cookie is httpOnly, so only server
 * code can clear it; the client form calls this right before redirecting.
 */
export async function clearPasswordResetPending() {
  (await cookies()).delete(PW_RESET_PENDING_COOKIE);
}

export async function signOutAdmin() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/admin/login");
}

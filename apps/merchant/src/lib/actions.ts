"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  createClient,
  requestPasswordReset as requestReset,
  checkEmailAvailability as checkEmail,
  type PasswordResetResult,
  type EmailAvailability,
} from "@ecomstrait/auth/server";
import { PW_RESET_PENDING_COOKIE } from "@ecomstrait/auth/middleware";
import { siteUrl } from "@/lib/site-url";

/**
 * Signup pre-check: one email, one account across the supplier and merchant
 * apps (they share the same auth users). See checkEmailAvailability.
 */
export async function checkEmailAvailability(email: string): Promise<EmailAvailability> {
  return checkEmail(email);
}

/** Forgot-password: sends the reset email only if the address is on file. */
export async function requestPasswordReset(email: string): Promise<PasswordResetResult> {
  return requestReset(email, siteUrl());
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // Defensive, not load-bearing for the normal flow (a pending-reset session
  // currently can't reach anywhere with a sign-out control) — just makes
  // sure a stale lock cookie from an abandoned reset can never carry over
  // onto whatever this browser signs into next.
  (await cookies()).delete(PW_RESET_PENDING_COOKIE);
  redirect("/login");
}

/**
 * Called once `updateUser({ password })` actually succeeds on
 * /reset-password — see PW_RESET_PENDING_COOKIE's doc comment
 * (packages/auth/src/middleware.ts) for why this gate exists at all. The
 * cookie is httpOnly, so only server code can clear it; the client form
 * calls this right before its own redirect to /dashboard.
 */
export async function clearPasswordResetPending() {
  const store = await cookies();
  store.delete(PW_RESET_PENDING_COOKIE);
}

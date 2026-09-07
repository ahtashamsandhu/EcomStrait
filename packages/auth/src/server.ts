import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createAdminClient } from "@ecomstrait/db/admin";
import type { Database } from "@ecomstrait/db/types";

/**
 * Supabase client for Server Components, Route Handlers, and Server Actions.
 * Reads/writes the session cookie via Next's async `cookies()`.
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component where cookies are read-only.
            // The middleware refreshes the session cookie, so this is safe to ignore.
          }
        },
      },
    },
  );
}

export type PasswordResetResult =
  | { status: "sent" }
  | { status: "not_found" }
  | { status: "error"; message: string };

/**
 * Forgot-password, server side. Looks the address up first and only sends
 * the reset email when an account exists, so the form can tell the user
 * which of the two happened.
 *
 * Supabase's own `resetPasswordForEmail` deliberately never reveals whether
 * an email is registered; the product decision here is the opposite — a typo
 * should get "this email does not exist", not a "check your inbox" that never
 * arrives. That's why this runs on the server through the admin client
 * (`auth_email_exists` is service_role-only) rather than from the browser.
 *
 * `redirectTo` is the app's origin — the "Reset Password" email template
 * appends /auth/confirm?token_hash=…&type=recovery&next=/reset-password
 * itself via {{ .RedirectTo }}, which verifies the token_hash directly and so
 * works when the link is opened on a different device than requested it.
 */
export async function requestPasswordReset(
  rawEmail: string,
  redirectTo: string,
): Promise<PasswordResetResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!email) return { status: "error", message: "Please enter your email address." };

  const admin = createAdminClient();
  if (!admin) {
    return { status: "error", message: "Password reset is not configured. Please try again later." };
  }

  const { data: exists, error: lookupError } = await admin.rpc("auth_email_exists", {
    p_email: email,
  });
  if (lookupError) return { status: "error", message: lookupError.message };
  if (!exists) return { status: "not_found" };

  const { error } = await admin.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) return { status: "error", message: error.message };
  return { status: "sent" };
}

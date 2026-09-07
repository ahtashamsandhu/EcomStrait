import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
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

  // The "does this email exist" answer is a product decision, but it must
  // not be free to ask at scale: throttle per client address (and per
  // address asked about) before touching the lookup.
  const throttled = await passwordResetThrottled(admin, email);
  if (throttled) {
    return { status: "error", message: "Too many reset attempts. Please wait a few minutes and try again." };
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

export type EmailAvailability =
  | { status: "available" }
  | { status: "taken" }
  | { status: "error"; message: string };

/**
 * Signup pre-check: is this email already registered on the platform?
 *
 * The supplier and merchant apps share one Supabase project, so an address
 * used for a supplier account is the same auth user in the merchant app. With
 * email confirmation on, `signUp` for an existing address deliberately looks
 * like success (anti-enumeration) — the person would be sent to "check your
 * inbox" for a mail that never comes. The product decision is the opposite:
 * one email, one account, and say so up front. Runs through the admin client
 * because `auth_email_exists` is service_role-only; the same per-IP/per-email
 * throttle as password reset keeps it from being a free enumeration oracle.
 */
export async function checkEmailAvailability(rawEmail: string): Promise<EmailAvailability> {
  const email = rawEmail.trim().toLowerCase();
  if (!email || !email.includes("@")) return { status: "error", message: "Please enter a valid email address." };

  const admin = createAdminClient();
  // Without the service key we can't look it up — let signUp decide instead.
  if (!admin) return { status: "available" };

  const throttled = await lookupThrottled(admin, "signup", email);
  if (throttled) {
    return { status: "error", message: "Too many attempts. Please wait a few minutes and try again." };
  }

  const { data: exists, error } = await admin.rpc("auth_email_exists", { p_email: email });
  if (error) return { status: "error", message: error.message };
  return exists ? { status: "taken" } : { status: "available" };
}

type RateLimitClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: { allowed: boolean }[] | null; error: { message: string } | null }>;
};

async function passwordResetThrottled(admin: unknown, email: string): Promise<boolean> {
  return lookupThrottled(admin, "pwreset", email);
}

/** Per-IP and per-email throttle for the "does this email exist" lookups. */
async function lookupThrottled(admin: unknown, kind: "pwreset" | "signup", email: string): Promise<boolean> {
  let ip = "unknown";
  try {
    const h = await headers();
    ip = (h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "unknown").split(",")[0].trim() || "unknown";
  } catch {
    /* outside a request scope: fall through with "unknown" */
  }
  const client = admin as RateLimitClient;
  const buckets: [string, number][] = [
    [`${kind}:ip:${ip}`, 10],
    [`${kind}:email:${email}`, 5],
  ];
  for (const [bucket, limit] of buckets) {
    try {
      const { data, error } = await client.rpc("bump_rate_limit", {
        p_bucket: bucket.slice(0, 200),
        p_window_seconds: 900,
        p_limit: limit,
      });
      if (error) continue; // fail open: the limiter must never block resets by itself
      if (data?.[0] && !data[0].allowed) return true;
    } catch {
      /* fail open */
    }
  }
  return false;
}

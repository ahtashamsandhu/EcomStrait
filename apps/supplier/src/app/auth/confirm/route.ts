import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@ecomstrait/auth/server";
import { safeNextPath } from "@ecomstrait/auth/redirect";
import { PW_RESET_PENDING_COOKIE } from "@ecomstrait/auth/middleware";

/**
 * Verifies a `token_hash` emailed by Supabase (password recovery, magic
 * link, invite) and establishes a session — used instead of /auth/callback's
 * `?code=` PKCE exchange for these links specifically.
 *
 * PKCE requires the code verifier that was stored in the browser at request
 * time, so it only works if the link is opened in that same browser. A
 * password-reset email is disproportionately opened somewhere else (a phone's
 * mail app while the request was made on a laptop), which silently fails
 * `exchangeCodeForSession` and dumps the visitor on /login with no
 * explanation. `verifyOtp` checks the token itself, server-side, with no such
 * requirement — Supabase's documented fix for exactly this failure mode.
 *
 * Requires the corresponding email template (Dashboard → Authentication →
 * Email Templates → "Reset Password") to link here instead of the default
 * `{{ .ConfirmationURL }}` — see Docs/prompts or ask the team for the exact
 * template body.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNextPath(searchParams.get("next"));

  if (token_hash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      const res = NextResponse.redirect(`${origin}${next}`);
      // A recovery link logs the visitor in before they've set a password.
      // Lock the session to /reset-password until they actually do (the
      // middleware enforces this; see PW_RESET_PENDING_COOKIE).
      if (type === "recovery") {
        res.cookies.set(PW_RESET_PENDING_COOKIE, "1", {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: 3600,
        });
      }
      return res;
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}

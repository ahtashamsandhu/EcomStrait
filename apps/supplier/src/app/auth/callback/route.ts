import { NextResponse } from "next/server";
import { createClient } from "@ecomstrait/auth/server";
import { safeNextPath } from "@ecomstrait/auth/redirect";

/**
 * Handles both flows that land here with a `?code=`:
 *   - OAuth sign-in (Google), and
 *   - email confirmation (default Supabase template redirects here via PKCE).
 * Exchanges the code for a session cookie, then continues into the app.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}

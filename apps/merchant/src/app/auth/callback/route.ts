import { NextResponse } from "next/server";
import { createClient } from "@ecomstrait/auth/server";
import { safeNextPath } from "@ecomstrait/auth/redirect";
import { ensureMerchantRole } from "@/lib/merchant-role";

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


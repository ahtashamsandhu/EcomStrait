import { NextResponse } from "next/server";
import { createAdminClient } from "@ecomstrait/db/admin";
import { runWeeklySettlement } from "@/lib/settlement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Weekly settlement run (Docs/Credits-Settlement-Plan.md, §4).
 *
 * Same shape as /api/cron/sweep-drafts: a plain authenticated endpoint, not
 * pg_cron, so any scheduler that can make an HTTPS call on a weekly schedule
 * (Vercel Cron, GitHub Actions, etc.) can drive it.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }

  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "Database isn't configured." }, { status: 503 });

  const result = await runWeeklySettlement(admin);
  return NextResponse.json(result);
}

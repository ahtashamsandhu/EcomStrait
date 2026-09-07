import { NextResponse } from "next/server";
import { merchantUrl } from "@/lib/stripe";
import { resolveStore, writeCart } from "@/lib/storefront-api";
import { confirmOrder } from "@/lib/storefront-orders";

export const runtime = "nodejs";

/**
 * GET /api/storefront/:storeId/checkout/return?session_id=...
 *
 * Where Stripe sends the customer back after paying. This is a Route Handler
 * rather than the thank-you page itself for one reason: Next.js only lets a
 * Route Handler or Server Action modify cookies. A Server Component page can
 * *read* the cart cookie but every attempt to delete it throws — which is
 * exactly why the paid items used to survive checkout.
 *
 * It also runs on whichever host the customer shopped on (the cart cookie is
 * per-host, and the storefront's own API calls are same-origin even on a
 * merchant's connected domain — see proxy.ts), so the cookie is cleared where
 * it actually lives before we hand off to the thank-you page.
 */
export async function GET(req: Request, { params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const sessionId = new URL(req.url).searchParams.get("session_id");

  const success = new URL(`/store/${storeId}/success`, merchantUrl());
  if (sessionId) success.searchParams.set("session_id", sessionId);

  if (sessionId && (await resolveStore(storeId))) {
    try {
      // Only a paid session confirms (see confirmOrder) — a customer who
      // lands here with a stale or foreign id keeps their cart.
      const order = await confirmOrder(storeId, sessionId);
      if (order) await writeCart(storeId, []);
    } catch {
      /* best-effort: the customer must still reach the thank-you page */
    }
  }

  // 303 so the browser always follows with a GET, whatever brought us here.
  return NextResponse.redirect(success, { status: 303, headers: { "Cache-Control": "no-store" } });
}

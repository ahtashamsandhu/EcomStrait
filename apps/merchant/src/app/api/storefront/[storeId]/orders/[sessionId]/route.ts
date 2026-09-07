import { apiError, apiOk } from "@/lib/api-response";
import { CHECKOUT_LIMIT, guard } from "@/lib/rate-limit";
import { resolveStore, writeCart } from "@/lib/storefront-api";
import { confirmOrder, getOrderBySession, type OrderView } from "@/lib/storefront-orders";

/**
 * The session id is the only capability here, and it travels in the
 * thank-you page URL (history, referrers, support screenshots). The buyer
 * already knows their own email; anyone else holding the id gets only enough
 * of it to recognise the order.
 */
function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

function publicView(order: OrderView): OrderView {
  return { ...order, customerEmail: maskEmail(order.customerEmail) };
}

export const runtime = "nodejs";

/**
 * GET  — read an order that's already recorded.
 * POST — confirm a Stripe session and record it (idempotent), then clear the
 *        cart. This is what a theme calls on its thank-you page.
 *
 * The Stripe session id is the capability here: it's unguessable and only the
 * buyer who completed checkout has it, so no customer login is required.
 */

export async function GET(
  req: Request,
  { params }: { params: Promise<{ storeId: string; sessionId: string }> },
) {
  const { storeId, sessionId } = await params;
  const limited = await guard(req, "order", storeId, CHECKOUT_LIMIT);
  if (limited) return limited;
  if (!(await resolveStore(storeId))) return apiError("Store not found", 404);

  const order = await getOrderBySession(storeId, sessionId);
  if (!order) return apiError("Order not found", 404);
  return apiOk({ order: publicView(order) });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ storeId: string; sessionId: string }> },
) {
  const { storeId, sessionId } = await params;
  // Each confirmation of an unknown session is a Stripe API call — keep the
  // same cap as checkout itself so the id space can't be probed for free.
  const limited = await guard(req, "order", storeId, CHECKOUT_LIMIT);
  if (limited) return limited;
  if (!(await resolveStore(storeId))) return apiError("Store not found", 404);

  let order: OrderView | null = null;
  try {
    order = await confirmOrder(storeId, sessionId);
  } catch {
    // A malformed or foreign session id makes Stripe throw; that is a 409
    // for the caller, not a stack trace.
    order = null;
  }
  if (!order) return apiError("That checkout isn't complete", 409);

  // The purchase succeeded — the cart it came from is done.
  await writeCart(storeId, []);
  return apiOk({ order: publicView(order) });
}

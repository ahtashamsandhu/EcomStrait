import { apiError, apiOk, readJson } from "@/lib/api-response";
import { CHECKOUT_LIMIT, guard } from "@/lib/rate-limit";
import { getStripe, merchantUrl } from "@/lib/stripe";
import { resolveStoreIdByDomain } from "@/lib/storefront";
import { priceCart, readCart, resolveStore, type RawLine } from "@/lib/storefront-api";

export const runtime = "nodejs";

const COUNTRIES = ["US", "CA", "GB", "AU", "PK", "IN", "AE", "DE", "FR", "NL", "SE", "ES", "IT", "SG"];

type Body = { lines?: { productId?: unknown; quantity?: unknown }[] };

/**
 * The origin Stripe should send the customer back to after paying.
 *
 * The cart is a per-host cookie, and a merchant's connected domain serves the
 * storefront (and its same-origin API calls) under that host — so the return
 * hop that clears the cart has to land on the same host the customer shopped
 * on, or it clears nothing. The Host header alone isn't trusted for that: it
 * only wins when it's the domain verified for THIS store; anything else goes
 * back to our own origin.
 */
async function returnOrigin(req: Request, storeId: string): Promise<string> {
  const own = merchantUrl();
  const host = req.headers.get("host")?.split(":")[0].toLowerCase();
  if (!host) return own;
  try {
    if (new URL(own).hostname.toLowerCase() === host) return own;
  } catch {
    return own;
  }
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".vercel.app")) return own;
  const owner = await resolveStoreIdByDomain(host);
  return owner === storeId ? `https://${host}` : own;
}

/**
 * POST /api/storefront/:storeId/checkout
 *
 * Creates a Stripe Checkout session for the stored cart, or for an explicit
 * `lines` array (useful for buy-now). Either way the server re-prices from the
 * approved catalog — a client-supplied price is never trusted.
 */
export async function POST(req: Request, { params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  // Checkout creates a Stripe session per call — tighter cap than the cart.
  const limited = await guard(req, "checkout", storeId, CHECKOUT_LIMIT);
  if (limited) return limited;

  const store = await resolveStore(storeId);
  if (!store) return apiError("Store not found", 404);

  const stripe = getStripe();
  if (!stripe) return apiError("Checkout isn't available right now", 503);

  const body = await readJson<Body>(req);
  const explicit: RawLine[] = Array.isArray(body?.lines)
    ? body.lines
        .filter((l) => typeof l?.productId === "string" && typeof l?.quantity === "number")
        .map((l) => ({ productId: l.productId as string, quantity: Math.trunc(l.quantity as number) }))
    : [];

  const source = explicit.length ? explicit : await readCart(storeId);
  const cart = await priceCart(storeId, source);
  if (!cart.lines.length) {
    return apiError(
      cart.removed.length ? "Nothing in your cart is available any more" : "Your cart is empty",
      400,
    );
  }

  const base = merchantUrl();
  const origin = await returnOrigin(req, storeId);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: cart.lines.map((l) => ({
      quantity: l.quantity,
      price_data: {
        currency: cart.currency,
        product_data: { name: l.title },
        unit_amount: Math.round(l.unitPrice * 100),
      },
    })),
    shipping_address_collection: { allowed_countries: COUNTRIES as never },
    // The supplier fulfilling the order needs a phone number for delivery
    // coordination (especially COD) — Stripe won't collect it otherwise.
    phone_number_collection: { enabled: true },
    // Not the thank-you page directly: the `return` Route Handler clears the
    // cart cookie (a page can't) and then forwards to it.
    success_url: `${origin}/api/storefront/${storeId}/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/store/${storeId}`,
    metadata: {
      store_id: storeId,
      lines: JSON.stringify(cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity }))),
    },
  });

  return apiOk({
    url: session.url,
    sessionId: session.id,
    subtotal: cart.subtotal,
    // Surface anything dropped between the cart page and checkout.
    removed: cart.removed,
    adjusted: cart.adjusted,
  });
}

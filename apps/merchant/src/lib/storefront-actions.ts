"use server";

import { createAdminClient } from "@ecomstrait/db/admin";
import { getStripe, merchantUrl } from "@/lib/stripe";

const COUNTRIES: string[] = ["US", "CA", "GB", "AU", "PK", "IN", "AE", "DE", "FR", "NL", "SE", "ES", "IT", "SG"];

export type CartLine = { productId: string; quantity: number };

/** Create a guest Stripe Checkout for a storefront cart. Prices are server-trusted. */
export async function checkoutStore(
  storeId: string,
  lines: CartLine[],
): Promise<{ url?: string; error?: string }> {
  const stripe = getStripe();
  if (!stripe) return { error: "Checkout isn't available right now." };
  const admin = createAdminClient();
  if (!admin) return { error: "Store unavailable." };

  const ids = lines.map((l) => l.productId);
  if (!ids.length) return { error: "Your cart is empty." };

  const [{ data: sp }, { data: prods }] = await Promise.all([
    // Approved-only: a pending or declined line must never be purchasable,
    // even if a stale page still has its Add to cart button.
    admin
      .from("store_products")
      .select("product_id, price")
      .eq("store_id", storeId)
      .eq("status", "approved")
      .in("product_id", ids),
    // Published-only for the same reason: an unpublished product is withdrawn
    // and must not be sellable from a page that was loaded before that.
    admin.from("products").select("id, title").in("id", ids).eq("status", "published"),
  ]);
  const priceMap = new Map((sp ?? []).map((r) => [r.product_id, r.price]));
  const nameMap = new Map((prods ?? []).map((p) => [p.id, p.title]));

  const lineItems = lines
    .filter((l) => priceMap.has(l.productId) && nameMap.has(l.productId))
    .map((l) => ({
      quantity: Math.max(1, Math.min(99, Math.trunc(l.quantity))),
      price_data: {
        currency: "usd",
        product_data: { name: nameMap.get(l.productId) ?? "Product" },
        unit_amount: Math.round(((priceMap.get(l.productId) as number | null) ?? 0) * 100),
      },
    }))
    .filter((li) => li.price_data.unit_amount > 0);

  if (!lineItems.length) return { error: "These products aren't available for purchase." };

  const base = merchantUrl();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: lineItems,
    shipping_address_collection: { allowed_countries: COUNTRIES as never },
    success_url: `${base}/store/${storeId}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/store/${storeId}`,
    metadata: { store_id: storeId, lines: JSON.stringify(lines) },
  });

  return { url: session.url ?? undefined };
}

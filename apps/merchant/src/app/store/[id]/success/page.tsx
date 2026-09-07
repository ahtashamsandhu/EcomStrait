import Link from "next/link";
import type { Metadata } from "next";
import { CheckCircle2 } from "lucide-react";
import { getStorefront } from "@/lib/storefront";
import { confirmOrder } from "@/lib/storefront-orders";
import { ClearCartOnMount } from "@/components/storefront/clear-cart-on-mount";

export const metadata: Metadata = { title: "Thank you" };
// Overrides the `/store` layout's `revalidate = 60` — this page confirms one
// customer's own order on every real visit; it must never serve a cached
// response meant for a different customer's session_id.
//
// Clearing the cart is NOT done here: a Server Component can't modify cookies
// (Next.js throws), so that lives in the `checkout/return` Route Handler that
// Stripe redirects to before this page, with `ClearCartOnMount` as a
// client-side fallback.
export const dynamic = "force-dynamic";

export default async function SuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { id } = await params;
  const { session_id } = await searchParams;
  let paid = false;
  if (session_id) {
    try {
      // Idempotent — normally already recorded by the return handler.
      paid = Boolean(await confirmOrder(id, session_id));
    } catch {
      /* best-effort: the thank-you page must render either way */
    }
  }
  const store = await getStorefront(id);

  return (
    <main className="grid min-h-screen place-items-center bg-ink-50/50 px-6 text-center">
      {paid && <ClearCartOnMount storeId={id} />}
      <div className="max-w-md">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand-50 text-brand-600">
          <CheckCircle2 className="h-7 w-7" />
        </span>
        <h1 className="mt-4 text-2xl font-bold text-ink-950">Thank you for your order!</h1>
        <p className="mt-2 text-sm text-ink-500">
          Your order is confirmed{store ? ` at ${store.name}` : ""}. You&apos;ll get an email with the details, and the supplier is preparing your shipment.
        </p>
        {store && (
          <Link href={`/store/${id}`} className="mt-6 inline-flex items-center gap-2 rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">
            Continue shopping
          </Link>
        )}
      </div>
    </main>
  );
}

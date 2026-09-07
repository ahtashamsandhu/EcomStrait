"use client";

import { useEffect } from "react";

/**
 * Fallback for the thank-you page: empties the server cart from the browser.
 *
 * The primary clear happens in the checkout `return` Route Handler before the
 * customer ever reaches this page. This covers a Stripe session created
 * before that handler existed (its success_url still points straight here),
 * or a cookie the redirect couldn't drop for any reason — the page itself is
 * a Server Component and can't modify cookies.
 */
export function ClearCartOnMount({ storeId }: { storeId: string }) {
  useEffect(() => {
    void fetch(`/api/storefront/${storeId}/cart`, { method: "DELETE" }).catch(() => {
      /* best-effort */
    });
  }, [storeId]);
  return null;
}

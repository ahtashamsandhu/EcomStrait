import "server-only";
import { merchantBaseUrl } from "@/lib/merchant-url";
import { signedInternalHeaders } from "@/lib/internal-request";

/**
 * Tell the merchant app to re-push a product to every Shopify store selling it.
 *
 * Custom-website storefronts read our tables live and are already correct the
 * moment a supplier saves. Shopify stores hold their own copy, so without this
 * an edit never leaves our database and a stock change lets other stores
 * oversell.
 *
 * Best-effort throughout: the supplier's save has already committed, and a
 * store that can't be reached now is corrected by the next change or provision.
 * Never awaited in a way that can fail the action.
 */
export async function syncProductToStores(
  productIds: string | string[],
  opts: {
    content?: boolean;
    stock?: boolean;
    price?: boolean;
    status?: boolean;
    /**
     * Retail price before this edit. Listings still sitting at it follow the
     * new price; ones the merchant repriced keep theirs. Omitted means no
     * listing price moves.
     */
    previousPrice?: number | null;
  } = {},
): Promise<void> {
  const ids = (Array.isArray(productIds) ? productIds : [productIds]).filter(Boolean);
  if (!ids.length) return;

  const base = merchantBaseUrl();
  const body = JSON.stringify({ productIds: ids, ...opts });
  const headers = signedInternalHeaders(body);
  if (!base || !headers) return;

  try {
    const res = await fetch(`${base}/api/internal/sync-product`, {
      method: "POST",
      headers,
      body,
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("[sync] store sync failed", res.status, await res.text().catch(() => ""));
    }
  } catch (e) {
    console.error("[sync] store sync error", e);
  }
}

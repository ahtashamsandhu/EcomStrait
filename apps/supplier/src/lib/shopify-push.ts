import "server-only";
import { merchantBaseUrl } from "@/lib/merchant-url";
import { signedInternalHeaders } from "@/lib/internal-request";

/**
 * Ask the merchant app to push an approved listing into its Shopify store.
 *
 * Shopify access tokens and the GraphQL client live in the merchant app, so the
 * supplier portal delegates rather than holding a second set of credentials.
 * Best-effort by design: approval has already been recorded, and a store that
 * can't be reached now picks the product up on its next provision.
 */
export async function pushListingToShopify(
  storeId: string,
  productId: string,
): Promise<{ pushed: boolean; note: string }> {
  const base = merchantBaseUrl();
  const payload = JSON.stringify({ storeId, productId });
  const headers = signedInternalHeaders(payload);
  if (!base || !headers) {
    return { pushed: false, note: "Approved. It goes live on the storefront right away." };
  }

  try {
    const res = await fetch(`${base}/api/internal/list-product`, {
      method: "POST",
      headers,
      body: payload,
      cache: "no-store",
    });

    if (!res.ok) {
      console.error("[listing] shopify push failed", res.status, await res.text().catch(() => ""));
      return {
        pushed: false,
        note: "Approved. The Shopify push didn't go through — it'll sync on the store's next provision.",
      };
    }

    const body = (await res.json().catch(() => ({}))) as { pushed?: boolean; reason?: string };
    if (body.pushed) return { pushed: true, note: "Approved and pushed to the merchant's Shopify store." };
    if (body.reason === "own_platform") {
      return { pushed: false, note: "Approved. It's live on the storefront now." };
    }
    return {
      pushed: false,
      note: "Approved. That store isn't provisioned yet, so it'll be included when it is.",
    };
  } catch (e) {
    console.error("[listing] shopify push error", e);
    return {
      pushed: false,
      note: "Approved. The Shopify push couldn't be reached — it'll sync on the next provision.",
    };
  }
}

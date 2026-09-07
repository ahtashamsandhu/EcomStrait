import { createAdminClient } from "@ecomstrait/db/admin";
import { secretMatches } from "@/lib/secret-compare";

/**
 * Auth for requests coming from the embedded Shopify app.
 *
 * Inside Shopify admin there's no EcomStrait session — the merchant is
 * identified by which shop the app is running on. The Shopify app server
 * (which already holds the shared secret for /api/shopify/connect) sends the
 * shop domain, and we resolve it to the linked store here. The secret is what
 * makes the shop claim trustworthy: it never leaves a server.
 */

export type EmbeddedContext = {
  admin: NonNullable<ReturnType<typeof createAdminClient>>;
  shopDomain: string;
  shopifyStoreId: string;
  /** The EcomStrait store linked to this shop, if one exists yet. */
  storeId: string | null;
  ownerUserId: string | null;
};

export type EmbeddedAuthResult =
  | { ok: true; ctx: EmbeddedContext }
  | { ok: false; status: number; error: string };

export async function authenticateEmbedded(
  req: Request,
  shop: string | null | undefined,
): Promise<EmbeddedAuthResult> {
  const secret = process.env.SHOPIFY_APP_SHARED_SECRET;
  const provided = req.headers.get("x-ecomstrait-secret");
  if (!secretMatches(provided, secret)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const domain = shop?.trim().toLowerCase();
  if (!domain) return { ok: false, status: 400, error: "shop is required" };

  const admin = createAdminClient();
  if (!admin) return { ok: false, status: 500, error: "Server not configured" };

  const { data: shopRow } = await admin
    .from("shopify_stores")
    .select("id, owner_user_id")
    .eq("shop_domain", domain)
    .maybeSingle();
  if (!shopRow) {
    return { ok: false, status: 404, error: "This shop isn't connected to EcomStrait" };
  }

  const { data: store } = await admin
    .from("stores")
    .select("id")
    .eq("shopify_store_id", shopRow.id)
    .maybeSingle();

  return {
    ok: true,
    ctx: {
      admin,
      shopDomain: domain,
      shopifyStoreId: shopRow.id,
      storeId: store?.id ?? null,
      ownerUserId: shopRow.owner_user_id,
    },
  };
}

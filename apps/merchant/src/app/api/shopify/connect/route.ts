import { NextResponse } from "next/server";
import { secretMatches } from "@/lib/secret-compare";
import { createAdminClient } from "@ecomstrait/db/admin";
import { sealToken } from "@/lib/token-crypto";

/**
 * The Shopify app calls this on install (afterAuth) with the shop + access
 * token, authenticated by a shared secret. We upsert it into the dev-store pool.
 */
export async function POST(req: Request) {
  const secret = process.env.SHOPIFY_APP_SHARED_SECRET;
  const provided = req.headers.get("x-ecomstrait-secret");
  if (!secretMatches(provided, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { shop?: string; accessToken?: string; scopes?: string; shopifyShopId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const shop = body.shop?.trim();
  const accessToken = body.accessToken?.trim();
  if (!shop || !accessToken) {
    return NextResponse.json({ error: "shop and accessToken required" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // The Shopify app calls this on every load, not just on install, so this must
  // only refresh the CONNECTION. Previously it upserted `status: "available"`
  // unconditionally, which meant a merchant opening their own store handed it
  // back to the pool and made it claimable by someone else.
  const connection = {
    access_token: sealToken(accessToken),
    scopes: body.scopes ?? null,
    shopify_shop_id: body.shopifyShopId ?? null,
    sync_status: "connected",
  };

  const { data: existing } = await admin
    .from("shopify_stores")
    .select("id, status, owner_user_id")
    .eq("shop_domain", shop)
    .maybeSingle();

  if (!existing) {
    // Genuinely new shop — it joins the pool as available.
    const { error } = await admin
      .from("shopify_stores")
      .insert({ shop_domain: shop, status: "available", ...connection });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, status: "available" });
  }

  // A shop with an owner, or one already handed over, keeps its status.
  const claimed =
    Boolean(existing.owner_user_id) ||
    existing.status === "transferred" ||
    existing.status === "archived";

  const { error } = await admin
    .from("shopify_stores")
    .update(claimed ? connection : { ...connection, status: "available" })
    .eq("id", existing.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, status: claimed ? existing.status : "available" });
}

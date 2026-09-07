"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@ecomstrait/auth/server";
import { createAdminClient } from "@ecomstrait/db/admin";
import { openToken, withOpenToken } from "@/lib/token-crypto";
import { productImage } from "@/lib/catalog";
import { flagReconnectNeeded, alertPoolEmpty } from "@/lib/ops-alert";
import { shopifyGraphql } from "@/lib/shopify";
import {
  pushProductsToShopify,
  fetchLocations,
  fetchShopCatalog,
  backfillProductMedia,
  backfillInventory,
  ensureDefaultShippingRate,
  fetchShippingState,
  fetchOnlineStorePublicationId,
  isTokenAlive,
} from "@/lib/shopify";
import {
  uploadAndPublishTheme,
  pushThemeSettings,
  settingsFromPlan,
  logoAssetFrom,
} from "@/lib/shopify-theme";
import {
  themeFilesWithContent,
  customContentSection,
  CUSTOM_CONTENT_FILE,
  type SectionProduct,
} from "@/lib/theme-content";
import { normalizePlan } from "@/lib/store-plan";
import type { StorePlan } from "@/lib/ecomai";
import { getStoreProductsByIds } from "@/lib/storefront-api";
import { liquidThemeForStyle } from "@/lib/themes";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

/**
 * Resolve every `type: "products"` section's picks (e.g. "Best sellers")
 * into what `theme-content.ts` needs to render them — the same title/image/
 * price the custom storefront shows, plus each product's Shopify handle
 * (captured onto `store_products` at push time, see pushProductsToShopify)
 * so the generated card can link to the live product.
 *
 * Static markup rather than a native Shopify collection + featured-collection
 * section on purpose: it reuses the sync path every other content block
 * already goes through, with no new Shopify API surface (collectionCreate
 * etc.) and no settings_data.json shape to get right for a statically-
 * included section.
 */
async function resolveSectionProducts(
  admin: AdminClient,
  storeId: string,
  plan: Pick<StorePlan, "sections">,
): Promise<Record<string, SectionProduct[]>> {
  const productSections = (plan.sections ?? []).filter((s) => s.type === "products");
  if (!productSections.length) return {};

  const allIds = [...new Set(productSections.flatMap((s) => s.productIds ?? []))];
  if (!allIds.length) return {};

  const [products, { data: rows }] = await Promise.all([
    getStoreProductsByIds(storeId, allIds),
    admin
      .from("store_products")
      .select("product_id, shopify_handle")
      .eq("store_id", storeId)
      .in("product_id", allIds),
  ]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const handleById = new Map((rows ?? []).map((r) => [r.product_id, r.shopify_handle]));

  const out: Record<string, SectionProduct[]> = {};
  for (const s of productSections) {
    out[s.id] = (s.productIds ?? []).flatMap((id) => {
      const p = byId.get(id);
      if (!p) return [];
      const handle = handleById.get(id);
      return [{ title: p.title, image: p.image, price: p.price, url: handle ? `/products/${handle}` : null }];
    });
  }
  return out;
}

/**
 * Take a genuinely free, working store from the pool.
 *
 * Two things the old query got wrong and both were reachable in production:
 * a shop already referenced by another `stores` row could still read
 * `available` and be handed to a second merchant, and a shop whose token had
 * gone stale passed the `access_token is not null` filter only to fail on the
 * first Shopify call. Candidates are now cross-checked against live links and
 * probed before being claimed.
 */
async function claimPoolStore(
  admin: AdminClient,
  userId: string,
): Promise<{ id: string } | { error: string }> {
  const { data: candidates } = await admin
    .from("shopify_stores")
    .select("id, shop_domain, access_token")
    .eq("status", "available")
    .not("access_token", "is", null)
    .order("created_at", { ascending: true })
    .limit(20);
  if (!candidates?.length) {
    return { error: "No store is available right now — our team has been notified and is adding more. Try again shortly." };
  }

  // Any shop already attached to a store is in use, whatever its status says.
  const { data: linked } = await admin
    .from("stores")
    .select("shopify_store_id")
    .not("shopify_store_id", "is", null);
  const inUse = new Set((linked ?? []).map((l) => l.shopify_store_id));

  const stale: { id: string; shop_domain: string }[] = [];
  for (const candidate of candidates) {
    if (inUse.has(candidate.id)) continue;

    // A cheap probe beats claiming a store and failing three calls later.
    let alive = false;
    try {
      const res = await shopifyGraphql(candidate.shop_domain, openToken(candidate.access_token) ?? "")<{
        data?: { shop?: { name?: string } };
      }>(`{ shop { name } }`);
      alive = Boolean(res.data?.shop?.name);
    } catch {
      alive = false;
    }
    if (!alive) {
      stale.push({ id: candidate.id, shop_domain: candidate.shop_domain });
      continue;
    }

    const { data: won } = await admin
      .from("shopify_stores")
      .update({ status: "building", owner_user_id: userId, assigned_at: new Date().toISOString() })
      // Losing this race means another merchant claimed it first.
      .eq("id", candidate.id)
      .eq("status", "available")
      .select("id")
      .maybeSingle();
    if (won) return { id: won.id };
  }

  // Flag dead tokens so the admin pool view shows why they can't be used, and
  // email the team the first time each one breaks.
  for (const { id, shop_domain } of stale) {
    await flagReconnectNeeded(id, shop_domain);
  }

  await alertPoolEmpty(
    stale.length
      ? `${stale.length} available store(s) have rejected tokens and need reconnecting.`
      : "No stores are marked available.",
  );

  return {
    error: stale.length
      ? "No store is ready right now — our team has been notified and is preparing one. Try again shortly."
      : "No store is available right now — our team has been notified and is adding more. Try again shortly.",
  };
}

/**
 * Provision a Shopify-path store: claim an available store from the pool,
 * link it, and push the AI-built products via the Admin API.
 * Requires a connected store in the pool (populated by the Shopify app on install).
 */
export async function provisionShopifyStore(storeId: string): Promise<{ error?: string; ok?: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data: store } = await supabase
    .from("stores")
    .select("id, type, shopify_store_id, theme, content, logo_url, name")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!store) return { error: "Store not found." };
  if (!store.type.startsWith("shopify")) return { error: "Not a Shopify store." };

  const admin = createAdminClient();
  if (!admin) return { error: "Server not configured." };

  // Use the already-linked pool store, or claim an available one.
  let sid = store.shopify_store_id;
  const claimedNow = !sid;
  if (!sid) {
    const claimed = await claimPoolStore(admin, user.id);
    if ("error" in claimed) return { error: claimed.error };
    sid = claimed.id;
    // Attaching a shop is platform work (a session may only ever detach one —
    // see guard_stores); ownership of `storeId` was verified above.
    await admin.from("stores").update({ shopify_store_id: sid }).eq("id", storeId).eq("user_id", user.id);
  }

  const { data: rawShopRow } = await admin
    .from("shopify_stores")
    .select("shop_domain, access_token")
    .eq("id", sid)
    .maybeSingle();
  const shopRow = withOpenToken(rawShopRow);
  if (!shopRow?.access_token) return { error: "That Shopify store has no access token." };

  // Build the product list from the store's catalog — supplier-approved only.
  const { data: sp } = await admin
    .from("store_products")
    .select("product_id, price")
    .eq("store_id", storeId)
    .eq("status", "approved");
  const ids = (sp ?? []).map((r) => r.product_id);
  const { data: prods } = ids.length
    ? await admin.from("products").select("id, title, description, stock, reserved, images").in("id", ids)
    : { data: [] };
  const priceMap = new Map((sp ?? []).map((r) => [r.product_id, r.price]));
  const pushList = (prods ?? []).map((p) => ({
    title: p.title,
    price: priceMap.get(p.id) ?? null,
    description: p.description ?? null,
    sku: p.id, // lets the order webhook map back to our product
    inventory: Math.max(0, (p.stock ?? 0) - (p.reserved ?? 0)),
    images: (p.images ?? []).map((i: string) => productImage(i)).filter((u): u is string => Boolean(u)),
  }));

  /** Put a freshly-claimed shop back in the pool so a failure doesn't strand it. */
  async function releaseClaim() {
    if (!claimedNow || !sid) return;
    await admin!
      .from("shopify_stores")
      .update({ status: "available", owner_user_id: null, assigned_at: null })
      .eq("id", sid)
      .neq("status", "transferred");
    await supabase.from("stores").update({ shopify_store_id: null }).eq("id", storeId);
  }

  let result: Awaited<ReturnType<typeof pushProductsToShopify>>;
  try {
    result = await pushProductsToShopify(shopRow.shop_domain, shopRow.access_token, pushList);
  } catch (e) {
    await releaseClaim();
    return { error: `Couldn't reach Shopify: ${e instanceof Error ? e.message : "unknown error"}` };
  }

  for (const [ourId, shopifyProduct] of result.ids) {
    await admin
      .from("store_products")
      .update({
        shopify_product_id: shopifyProduct.id,
        shopify_handle: shopifyProduct.handle,
        shopify_synced_at: new Date().toISOString(),
      })
      .eq("store_id", storeId)
      .eq("product_id", ourId);
  }

  // A store with products but no shipping rate dies at checkout, so seed one.
  // Best-effort: never fail provisioning over it.
  let shippingNote = "";
  try {
    const ship = await ensureDefaultShippingRate(shopRow.shop_domain, shopRow.access_token);
    if (ship.created) shippingNote = " + shipping";
  } catch {
    /* reported by the launch checklist instead */
  }

  // Path 2 (shopify_liquid_theme): upload + publish our Liquid theme with the
  // store's brand settings. Requires the write_themes scope and a publicly
  // reachable NEXT_PUBLIC_MERCHANT_URL (Shopify fetches the theme zip).
  let themeNote = "";
  let themeGid: string | null = null;
  if (store.type === "shopify_liquid_theme") {
    const liquid = liquidThemeForStyle(store.theme);
    // Normalised rather than cast: `content` is free-form JSON, and the theme
    // now reads media and section blocks out of it that a bare cast wouldn't
    // guarantee are well formed.
    const plan = normalizePlan(store.content, store.name ?? undefined);
    // Picks for any "Best sellers"-style section — resolved before upload so
    // it ships in the same package as everything else, not a second sync.
    const productsBySection = await resolveSectionProducts(admin, storeId, plan);
    let themeRes: Awaited<ReturnType<typeof uploadAndPublishTheme>>;
    try {
      themeRes = await uploadAndPublishTheme(shopRow.shop_domain, shopRow.access_token, {
        themeName: liquid.name,
        // The merchant's content blocks are rendered into the package here —
        // they can't be theme settings, because Liquid can't read a JSON array.
        files: themeFilesWithContent(liquid.files, plan, productsBySection),
        settings: settingsFromPlan(plan, store.name, store.theme, store.id),
        logo: logoAssetFrom(store.logo_url),
      });
    } catch (e) {
      themeRes = { ok: false, error: e instanceof Error ? e.message : "theme upload threw" };
    }

    if (themeRes.ok) {
      themeGid = themeRes.themeGid;
      themeNote = " + theme";
    } else {
      // A liquid-theme store without its theme isn't provisioned. Reporting
      // success here is what left stores linked but themeless, with the
      // Provision button gone and re-sync insisting the theme was missing.
      await admin
        .from("shopify_stores")
        .update({ sync_status: `theme upload failed: ${themeRes.error}` })
        .eq("id", sid);
      return {
        error: `Products pushed, but the theme upload failed: ${themeRes.error}. Fix that and provision again.`,
      };
    }
  }

  await supabase
    .from("stores")
    .update({ status: "ready_for_review", live_url: `https://${shopRow.shop_domain}` })
    .eq("id", storeId);
  await admin
    .from("shopify_stores")
    .update({
      status: "ready_for_review",
      sync_status: `pushed ${result.created} products${themeNote}${shippingNote}`,
      ...(themeGid ? { theme_id: themeGid } : {}),
    })
    .eq("id", sid);

  revalidatePath("/stores");
  return { ok: true };
}

/**
 * Re-sync EcomAI edits to a LIVE Shopify store: push the current plan (colors,
 * hero, logo and content blocks from `stores.content`) onto the already-
 * published theme via themeFilesUpsert. No re-create/re-publish — fast and safe.
 *
 * The content blocks matter here as much as the settings do. Provisioning runs
 * once, so when it was the only thing that generated
 * `sections/custom-content.liquid`, a merchant who added a gallery after
 * launching saw it in the builder preview and never on their store — and one
 * who deleted a section watched it stay up.
 */
export async function resyncShopifyTheme(storeId: string): Promise<{ error?: string; ok?: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data: store } = await supabase
    .from("stores")
    .select("id, type, shopify_store_id, content, logo_url, name, theme")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!store) return { error: "Store not found." };
  if (store.type !== "shopify_liquid_theme") {
    return { error: "Only EcomStrait-theme Shopify stores can be re-synced." };
  }
  if (!store.shopify_store_id) return { error: "Provision the store on Shopify first." };

  const admin = createAdminClient();
  if (!admin) return { error: "Server not configured." };

  const { data: rawShopRow } = await admin
    .from("shopify_stores")
    .select("shop_domain, access_token, theme_id")
    .eq("id", store.shopify_store_id)
    .maybeSingle();
  const shopRow = withOpenToken(rawShopRow);
  if (!shopRow?.access_token) return { error: "That Shopify store has no access token." };
  if (!shopRow.theme_id) {
    return {
      error:
        "No theme on this store yet — the upload didn't complete. Use \u201cRetry provisioning\u201d on the Stores page, then update again.",
    };
  }

  const plan = normalizePlan(store.content, store.name ?? undefined);
  const productsBySection = await resolveSectionProducts(admin, storeId, plan);

  const res = await pushThemeSettings(
    shopRow.shop_domain,
    shopRow.access_token,
    shopRow.theme_id,
    settingsFromPlan(plan, store.name, store.theme, store.id),
    {
      logo: logoAssetFrom(store.logo_url),
      files: { [CUSTOM_CONTENT_FILE]: customContentSection(plan, productsBySection) },
    },
  );
  if (!res.ok) return { error: res.error };

  await admin
    .from("shopify_stores")
    .update({ sync_status: "settings re-synced" })
    .eq("id", store.shopify_store_id);

  revalidatePath("/stores");
  return { ok: true };
}

/**
 * Push approved listings that aren't in the Shopify store yet.
 *
 * Provisioning only runs once, and re-syncing the theme doesn't touch products,
 * so a store that gains listings later (or whose first push failed) had no way
 * to catch up. Existing products are matched on SKU — which holds our product
 * id — so running this repeatedly is safe.
 */
export async function syncProductsToShopify(
  storeId: string,
): Promise<{ error?: string; created?: number; skipped?: number; note?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data: store } = await supabase
    .from("stores")
    .select("id, type, shopify_store_id")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!store) return { error: "Store not found." };
  if (!store.type.startsWith("shopify")) return { error: "Not a Shopify store." };
  if (!store.shopify_store_id) return { error: "Provision this store on Shopify first." };

  const admin = createAdminClient();
  if (!admin) return { error: "Server not configured." };

  const { data: rawShopRow } = await admin
    .from("shopify_stores")
    .select("shop_domain, access_token")
    .eq("id", store.shopify_store_id)
    .maybeSingle();
  const shopRow = withOpenToken(rawShopRow);
  if (!shopRow?.access_token) return { error: "That Shopify store has no access token." };

  // A stale token otherwise surfaces as a raw Shopify error with no next step.
  if (!(await isTokenAlive(shopRow.shop_domain, shopRow.access_token))) {
    await flagReconnectNeeded(store.shopify_store_id, shopRow.shop_domain);
    return {
      error:
        "This store's connection needs restoring. Our team has been notified — we'll sort it and you can try again shortly.",
    };
  }

  const { data: sp } = await admin
    .from("store_products")
    .select("product_id, price, shopify_product_id")
    .eq("store_id", storeId)
    .eq("status", "approved");
  const ids = (sp ?? []).map((r) => r.product_id);
  if (!ids.length) {
    return { created: 0, skipped: 0, note: "Nothing approved to sync yet — check your listing requests." };
  }

  const { data: prods } = await admin
    .from("products")
    .select("id, title, description, stock, reserved, images")
    .in("id", ids);
  const priceMap = new Map((sp ?? []).map((r) => [r.product_id, r.price]));
  const linkedMap = new Map((sp ?? []).map((r) => [r.product_id, r.shopify_product_id]));

  let catalog: Awaited<ReturnType<typeof fetchShopCatalog>>;
  try {
    catalog = await fetchShopCatalog(shopRow.shop_domain, shopRow.access_token);
  } catch (e) {
    return { error: `Couldn't read the Shopify catalog: ${e instanceof Error ? e.message : "unknown error"}` };
  }

  // Already synced if we recorded a Shopify product that still exists. Listings
  // from before that column existed fall back to a SKU match, and get their id
  // backfilled so the next sync doesn't need the fallback.
  const pending: typeof prods = [];
  const backfill: { product_id: string; shopify_product_id: string }[] = [];
  for (const p of prods ?? []) {
    const linked = linkedMap.get(p.id);
    if (linked && catalog.productIds.has(linked)) continue;
    const bySku = catalog.skuToProductId.get(p.id);
    if (bySku) {
      backfill.push({ product_id: p.id, shopify_product_id: bySku });
      continue;
    }
    pending.push(p);
  }
  for (const b of backfill) {
    await admin
      .from("store_products")
      .update({ shopify_product_id: b.shopify_product_id, shopify_synced_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .eq("product_id", b.product_id);
  }
  // Products pushed before media existed have none — add it rather than
  // making the merchant delete and re-sync everything.
  const needMedia = (prods ?? [])
    .filter((p) => {
      const linked = linkedMap.get(p.id) ?? catalog.skuToProductId.get(p.id);
      return linked && catalog.withoutMedia.has(linked) && (p.images ?? []).length > 0;
    })
    .map((p) => ({
      productId: (linkedMap.get(p.id) ?? catalog.skuToProductId.get(p.id)) as string,
      title: p.title,
      images: (p.images ?? []).map((i: string) => productImage(i)).filter((u): u is string => Boolean(u)),
    }));
  const media = needMedia.length
    ? await backfillProductMedia(shopRow.shop_domain, shopRow.access_token, needMedia)
    : { updated: 0, errors: [] };

  // Products pushed before inventory sync existed sit there untracked. The
  // normal path skips them for being present, so repair them here.
  const needStock = (prods ?? [])
    .flatMap((p) => {
      const linked = linkedMap.get(p.id) ?? catalog.skuToProductId.get(p.id);
      const item = linked ? catalog.untracked.get(linked) : undefined;
      if (!item) return [];
      return [
        {
          inventoryItemId: item.inventoryItemId,
          title: p.title,
          quantity: Math.max(0, (p.stock ?? 0) - (p.reserved ?? 0)),
        },
      ];
    });
  const stock = needStock.length
    ? await backfillInventory(shopRow.shop_domain, shopRow.access_token, needStock)
    : { updated: 0, errors: [] };

  const skipped = (prods ?? []).length - pending.length;
  if (!pending.length) {
    return {
      created: 0,
      skipped,
      note:
        media.updated || stock.updated
          ? `All ${skipped} already in Shopify — ${[
              media.updated ? `added images to ${media.updated}` : "",
              stock.updated ? `set stock on ${stock.updated}` : "",
            ]
              .filter(Boolean)
              .join(", ")}.`
          : `All ${skipped} approved product${skipped === 1 ? " is" : "s are"} already in Shopify.`,
    };
  }

  const result = await pushProductsToShopify(
    shopRow.shop_domain,
    shopRow.access_token,
    pending.map((p) => ({
      title: p.title,
      price: priceMap.get(p.id) ?? null,
      description: p.description ?? null,
      sku: p.id,
      inventory: Math.max(0, (p.stock ?? 0) - (p.reserved ?? 0)),
      images: (p.images ?? []).map((i: string) => productImage(i)).filter((u): u is string => Boolean(u)),
    })),
  );

  // Record which Shopify product each listing became.
  for (const [ourId, shopifyProduct] of result.ids) {
    await admin
      .from("store_products")
      .update({
        shopify_product_id: shopifyProduct.id,
        shopify_handle: shopifyProduct.handle,
        shopify_synced_at: new Date().toISOString(),
      })
      .eq("store_id", storeId)
      .eq("product_id", ourId);
  }

  await admin
    .from("shopify_stores")
    .update({ sync_status: `synced ${result.created} products` })
    .eq("id", store.shopify_store_id);
  revalidatePath("/stores");

  const allErrors = [...result.errors, ...media.errors, ...stock.errors];
  if (allErrors.length) {
    return {
      created: result.created,
      skipped,
      error: `${result.created} added, but some failed: ${allErrors.slice(0, 2).join("; ")}`,
    };
  }
  return {
    created: result.created,
    skipped,
    note: `Added ${result.created} product${result.created === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} already there` : ""}${media.updated ? `, added images to ${media.updated}` : ""}${stock.updated ? `, set stock on ${stock.updated}` : ""}.`,
  };
}

export type ReadinessCheck = {
  id: string;
  label: string;
  /** null = we can't determine it from the API. */
  ok: boolean | null;
  detail: string;
  /** Where the merchant fixes it, when it's a Shopify admin setting. */
  fixPath?: string;
};

/**
 * Can this store actually take an order?
 *
 * Provisioning can succeed while the storefront is still uncheckoutable —
 * products unpublished, no shipping rate, no payment provider. This surfaces
 * those before a merchant discovers them at a dead checkout button.
 */
export async function getStoreReadiness(
  storeId: string,
): Promise<{ error?: string; shopDomain?: string; checks?: ReadinessCheck[] }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data: store } = await supabase
    .from("stores")
    .select("id, type, shopify_store_id")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!store) return { error: "Store not found." };
  if (!store.shopify_store_id) return { error: "Provision this store on Shopify first." };

  const admin = createAdminClient();
  if (!admin) return { error: "Server not configured." };

  const { data: rawShopRow } = await admin
    .from("shopify_stores")
    .select("shop_domain, access_token, theme_id")
    .eq("id", store.shopify_store_id)
    .maybeSingle();
  const shopRow = withOpenToken(rawShopRow);
  if (!shopRow?.access_token) return { error: "That Shopify store has no access token." };

  const shop = shopRow.shop_domain;
  const token = shopRow.access_token;
  const checks: ReadinessCheck[] = [];

  // Everything below needs a working token, so lead with it.
  if (!(await isTokenAlive(shop, token))) {
    await flagReconnectNeeded(store.shopify_store_id, shop);
    return {
      shopDomain: shop,
      checks: [
        {
          id: "connection",
          label: "Shopify connection",
          ok: false,
          detail:
            "Connection interrupted. Our team has been notified and is restoring it — nothing for you to do.",
        },
      ],
    };
  }

  // Products present and visible to the storefront.
  const catalog = await fetchShopCatalog(shop, token).catch(() => null);
  const gql = shopifyGraphql(shop, token);
  const vis = await gql<{
    data?: { products?: { nodes?: { publishedAt: string | null }[] } };
  }>(`{ products(first: 100) { nodes { publishedAt } } }`).catch(() => null);
  const nodes = vis?.data?.products?.nodes ?? [];
  const unpublished = nodes.filter((p) => !p.publishedAt).length;

  checks.push({
    id: "products",
    label: "Products in the store",
    ok: (catalog?.productIds.size ?? 0) > 0,
    detail: catalog ? `${catalog.productIds.size} product(s)` : "couldn't read the catalog",
  });
  checks.push({
    id: "published",
    label: "Products visible on the storefront",
    ok: nodes.length > 0 ? unpublished === 0 : null,
    detail:
      nodes.length === 0
        ? "no products to check"
        : unpublished === 0
          ? "all published to Online Store"
          : `${unpublished} not published — they stay hidden`,
  });

  if (store.type === "shopify_liquid_theme") {
    checks.push({
      id: "theme",
      label: "Theme installed",
      ok: Boolean(shopRow.theme_id),
      detail: shopRow.theme_id ? "EcomStrait theme published" : "not uploaded — run Retry provisioning",
    });
  }

  // Stock is written to one location. If that location doesn't fulfil online
  // orders, the storefront reads every product as sold out while admin shows
  // units on hand — the difference between two otherwise identical shops.
  const locations = await fetchLocations(shop, token);
  const onlineLoc = locations.find((l) => l.isActive && l.fulfillsOnlineOrders);
  checks.push({
    id: "inventory-location",
    label: "Stock location",
    ok: locations.length === 0 ? null : Boolean(onlineLoc),
    detail:
      locations.length === 0
        ? "couldn't read the shop's locations"
        : onlineLoc
          ? `${onlineLoc.name} — fulfils online orders`
          : `${locations.map((l) => l.name).join(", ")} — none fulfils online orders, so stock stays hidden from the storefront`,
    fixPath: "settings/locations",
  });

  const ship = await fetchShippingState(shop, token);
  checks.push({
    id: "shipping",
    label: "Shipping rate",
    ok: ship.hasRate,
    detail: ship.detail,
    fixPath: "settings/shipping",
  });

  // Publishing needs the scope; say so rather than reporting a false pass.
  const pub = await fetchOnlineStorePublicationId(shop, token);
  if (!pub) {
    checks.push({
      id: "scopes",
      label: "App permissions",
      ok: false,
      detail: "Reinstall the app — it can't publish products without newer permissions",
    });
  }

  // No Shopify API can enable a payment provider; only the owner can, in admin.
  checks.push({
    id: "payments",
    label: "Payments",
    ok: null,
    detail: "Set up a provider in Shopify — checkout stays disabled until you do",
    fixPath: "settings/payments",
  });

  return { shopDomain: shop, checks };
}

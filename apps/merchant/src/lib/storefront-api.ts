import { cache } from "react";
import { cookies } from "next/headers";
import { createAdminClient } from "@ecomstrait/db/admin";
import { productImage } from "@/lib/catalog";
import { isPublicStatus } from "@/lib/store-status";
import { UNCATEGORIZED, categoryLabel } from "@/lib/storefront-shared";

// Re-exported so existing importers of this module keep working — the real
// definitions live in storefront-shared.ts (see its header comment for why).
export { UNCATEGORIZED, categoryLabel };

/**
 * Data layer for the public storefront API.
 *
 * Every read is scoped to supplier-APPROVED listings on an own-platform store,
 * and every price is looked up server-side — the client only ever sends product
 * ids and quantities, never money.
 */

export const CART_COOKIE_DAYS = 30;
export const MAX_LINE_QTY = 99;

export type ApiProduct = {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  image: string | null;
  images: string[];
  price: number | null;
  /**
   * The supplier's retail price, shown struck through as "compare at" —
   * ONLY when the merchant's listed price actually undercuts it. This is a
   * real markdown computed from real data, never an invented "was" price:
   * a merchant who lists at (or above) retail simply has no compareAtPrice.
   */
  compareAtPrice: number | null;
  /** Units a customer can actually buy right now. */
  available: number;
  inStock: boolean;
  /** Supplier-set, same on every store — see products.sizes/material/fit_note. */
  sizes: string | null;
  material: string | null;
  fitNote: string | null;
  /** Merchant-set, per store — see store_products.shipping_note. */
  shippingNote: string | null;
  /** Supplier-authored (or EcomAI-enriched) page metadata — products.seo_title /
   *  seo_description. Until 2026-09-07 these never reached a storefront page
   *  (capability audit §14.3); the product detail pages' generateMetadata now
   *  prefers them over the title/description fallbacks. Optional so the
   *  builder's and gallery's hand-built demo products need not carry them. */
  seoTitle?: string | null;
  seoDescription?: string | null;
};

export type CartLine = {
  productId: string;
  title: string;
  image: string | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  available: number;
};

export type PricedCart = {
  lines: CartLine[];
  subtotal: number;
  itemCount: number;
  currency: "usd";
  /** Ids dropped because they're no longer purchasable, with the reason. */
  removed: { productId: string; reason: "unavailable" | "out_of_stock" }[];
  /** Ids whose quantity was reduced to the stock on hand. */
  adjusted: { productId: string; to: number }[];
};

export type StoreSummary = {
  id: string;
  name: string;
  logoUrl: string | null;
  theme: string | null;
  currency: "usd";
};

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

function admin(): Admin | null {
  return createAdminClient();
}

/** The store, if it exists and is a custom-website store. */
export async function resolveStore(storeId: string): Promise<StoreSummary | null> {
  const db = admin();
  if (!db) return null;
  const { data } = await db
    .from("stores")
    .select("id, name, logo_url, theme, type, status")
    .eq("id", storeId)
    .maybeSingle();
  // Same gate as getStorefront: a draft must not be readable, and above all
  // must not be purchasable, through the API either.
  if (!data || data.type !== "own_platform" || !isPublicStatus(data.status)) return null;
  return {
    id: data.id,
    name: data.name ?? "Store",
    logoUrl: data.logo_url,
    theme: data.theme,
    currency: "usd",
  };
}

/**
 * Looser than `resolveStore`: also accepts a provisioned Shopify-theme
 * store, for the one thing both selling paths share — newsletter capture.
 * Everything else public (products, cart, checkout) stays own_platform-only,
 * since a Shopify store's catalog and checkout are Shopify's, not ours.
 *
 * A Shopify-theme store's `status` never reaches "live" through the normal
 * launch flow (it tracks the builder draft, not the Shopify publish state —
 * see createStore in builder-actions.ts), so `isPublicStatus` isn't the
 * right gate here; "has it actually been provisioned" is.
 */
export async function resolveStoreForNewsletter(storeId: string): Promise<{ id: string; name: string } | null> {
  const db = admin();
  if (!db) return null;
  const { data } = await db
    .from("stores")
    .select("id, name, type, status, shopify_store_id")
    .eq("id", storeId)
    .maybeSingle();
  if (!data) return null;
  const isPublicOwn = data.type === "own_platform" && isPublicStatus(data.status);
  const isProvisionedShopify = data.type === "shopify_liquid_theme" && Boolean(data.shopify_store_id);
  if (!isPublicOwn && !isProvisionedShopify) return null;
  return { id: data.id, name: data.name ?? "Store" };
}

type ListingRow = { product_id: string; price: number | null; shipping_note: string | null };
type Listing = { price: number | null; shippingNote: string | null };

/**
 * Approved listings for a store, keyed by product id.
 *
 * `cache()`-wrapped: memoized per request (React's Server Component request
 * cache, not a persistent one), keyed on the arguments actually passed.
 * `db` is the module-level singleton `createAdminClient()` always returns
 * (same reference every call, so it doesn't break the cache key), and every
 * caller in this file that fetches ALL of a store's listings calls this the
 * same way — `approvedListings(db, storeId)`, no third argument — so one
 * home-page render that used to fire this query once per category band
 * (`listStoreProducts`) plus once more from `listStoreCategories` (itself
 * called both directly by a page and again internally by `getStorefrontNav`)
 * now fires it exactly once and reuses the result everywhere. Calls that add
 * a `productIds` filter (`getStoreProduct`, `getStoreProductsByIds`,
 * `priceCart`) each build a fresh array, so they don't hit this cache against
 * each other — a smaller, separate concern from the redundant full-store
 * fetches this exists to fix.
 */
const approvedListings = cache(async (db: Admin, storeId: string, productIds?: string[]) => {
  let query = db
    .from("store_products")
    .select("product_id, price, shipping_note")
    .eq("store_id", storeId)
    .eq("status", "approved");
  if (productIds?.length) query = query.in("product_id", productIds);
  const { data } = await query;
  return new Map<string, Listing>(
    (data ?? []).map((r: ListingRow) => [r.product_id, { price: r.price, shippingNote: r.shipping_note }]),
  );
});

function toApiProduct(
  p: {
    id: string;
    title: string;
    description: string | null;
    category: string | null;
    images: string[];
    retail_price: number | null;
    stock: number;
    reserved: number;
    sizes: string | null;
    material: string | null;
    fit_note: string | null;
    seo_title: string | null;
    seo_description: string | null;
  },
  listing: Listing | undefined,
): ApiProduct {
  const listedPrice = listing?.price ?? null;
  const available = Math.max(0, (p.stock ?? 0) - (p.reserved ?? 0));
  const price = listedPrice ?? p.retail_price;
  // A real markdown, not a fabricated "was" price: only set when the
  // merchant's own listed price genuinely undercuts the supplier's retail.
  const compareAtPrice =
    listedPrice != null && p.retail_price != null && listedPrice < p.retail_price
      ? p.retail_price
      : null;
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    category: p.category,
    image: productImage(p.images?.[0]),
    images: (p.images ?? []).map((i) => productImage(i)).filter((u): u is string => Boolean(u)),
    price,
    compareAtPrice,
    available,
    inStock: available > 0,
    sizes: p.sizes,
    material: p.material,
    fitNote: p.fit_note,
    shippingNote: listing?.shippingNote ?? null,
    seoTitle: p.seo_title?.trim() || null,
    seoDescription: p.seo_description?.trim() || null,
  };
}

const PRODUCT_COLUMNS =
  "id, title, description, category, images, retail_price, stock, reserved, status, sizes, material, fit_note, seo_title, seo_description";

export type ProductQuery = { q?: string; category?: string; page?: number; limit?: number };

/**
 * Paged product listing for a storefront. `category` is an exact match
 * against `products.category` (case-insensitive) — the same string
 * `listStoreCategories` groups by, so a category card's link and this query
 * always agree on what belongs to it.
 */
export async function listStoreProducts(
  storeId: string,
  { q = "", category, page = 1, limit = 24 }: ProductQuery,
): Promise<{ products: ApiProduct[]; total: number; page: number; limit: number }> {
  const db = admin();
  if (!db) return { products: [], total: 0, page, limit };

  const listed = await approvedListings(db, storeId);
  const ids = [...listed.keys()];
  if (!ids.length) return { products: [], total: 0, page, limit };

  // Filtering happens on `products`, so the count has to come from there too —
  // the approved-id set alone can't tell us how many match the search.
  const term = q.replace(/[%_\\,()]/g, " ").trim().slice(0, 80);
  const build = () => {
    let query = db
      .from("products")
      .select(PRODUCT_COLUMNS, { count: "exact" })
      .in("id", ids)
      .eq("status", "published");
    if (term) query = query.ilike("title", `%${term}%`);
    if (category === UNCATEGORIZED) query = query.is("category", null);
    else if (category) query = query.ilike("category", category);
    return query.order("title");
  };

  const size = Math.min(Math.max(1, limit), 60);
  const from = (Math.max(1, page) - 1) * size;
  const { data, count } = await build().range(from, from + size - 1);

  return {
    products: (data ?? []).map((p) => toApiProduct(p, listed.get(p.id))),
    total: count ?? 0,
    page: Math.max(1, page),
    limit: size,
  };
}

export type CategorySummary = {
  /** `UNCATEGORIZED` for the "no category set" group — a real page value, not a display label. */
  category: string;
  count: number;
  /** First product's primary image in this category, for the category card. */
  image: string | null;
};

/**
 * Every category present in a store's sellable catalog, with a count and a
 * representative image — the data behind the category nav and the
 * homepage's per-category bands.
 *
 * Fetches every approved+published listing's `category`/`images` and groups
 * in JS rather than a DB-side GROUP BY: the same bounded, no-pagination read
 * `approvedListings` already does for this store, just carried one step
 * further. A store's live catalog is small enough (tens to low hundreds of
 * products) that this is one query, not N.
 *
 * `cache()`-wrapped for the same reason as `approvedListings` above:
 * `getStorefrontNav` calls this internally, and every page function that
 * calls `getStorefrontNav` also calls this directly in the same
 * `Promise.all` for its own category bands/filter list — without this, that
 * was two independent, identical fetches every single render.
 */
export const listStoreCategories = cache(async (storeId: string): Promise<CategorySummary[]> => {
  const db = admin();
  if (!db) return [];

  const listed = await approvedListings(db, storeId);
  const ids = [...listed.keys()];
  if (!ids.length) return [];

  const { data } = await db
    .from("products")
    .select("category, images")
    .in("id", ids)
    .eq("status", "published");

  const groups = new Map<string, { count: number; image: string | null }>();
  for (const p of data ?? []) {
    const key = p.category?.trim() || UNCATEGORIZED;
    const existing = groups.get(key);
    const image = productImage(p.images?.[0]);
    if (existing) {
      existing.count += 1;
      if (!existing.image && image) existing.image = image;
    } else {
      groups.set(key, { count: 1, image });
    }
  }

  // Uncategorized last — it's a fallback bucket, not a merchandised category.
  return [...groups.entries()]
    .sort(([a], [b]) => (a === UNCATEGORIZED ? 1 : b === UNCATEGORIZED ? -1 : a.localeCompare(b)))
    .map(([category, g]) => ({ category, count: g.count, image: g.image }));
});

export type StorefrontNavLink = {
  label: string;
  href: string;
  /**
   * Set only on the single bundled "Categories" entry `getStorefrontNav`
   * builds when a store has more than one category — the real per-category
   * links live here instead of each getting its own top-level nav slot, so a
   * 5-category store shows one dropdown tab, not five. Absent (or one item)
   * means "plain link," same as before this field existed.
   */
  children?: StorefrontNavLink[];
};

const MAX_NAV_CATEGORIES = 6;

/**
 * The category nav — a store's real categories (a single direct link if
 * there's only one, or one "Categories" dropdown bundling all of them if
 * there's more) plus a "Shop all" catch-all, always joined by a "Sale" link
 * (the homepage's Sale band self-hides when nothing's actually marked down,
 * so this never needs its own existence check) and "About" when the store
 * has about content.
 *
 * One function so the homepage, the product page, and the listing page all
 * build the identical nav from the identical data — never three
 * independently-drifting copies of "which categories fit."
 *
 * `basePath` defaults to the `/store/<uuid>` prefix every link has always
 * used; a store reached through its own connected domain passes `""` so the
 * nav (and every link built from it) stays on the clean domain-relative path
 * instead of exposing the internal store id. See storefront-pages.tsx.
 */
export async function getStorefrontNav(
  storeId: string,
  opts: { about: boolean; blog?: boolean; pages?: { slug: string; title: string }[]; basePath?: string },
): Promise<StorefrontNavLink[]> {
  const base = opts.basePath ?? `/store/${storeId}`;
  // Sale/About are anchors on the home page only. On the id-path route
  // `base` is already an absolute `/store/<uuid>` prefix, so `${base}#sale`
  // lands on home regardless of which page the link was clicked from. On a
  // connected domain `base` is `""` — `${base}#sale` would then resolve
  // relative to whatever page it's clicked from (e.g. `/products#sale`
  // instead of `/#sale`), so those two anchors need the actual home path.
  const home = base || "/";
  const categories = await listStoreCategories(storeId);
  const categoryLinks: StorefrontNavLink[] = categories.slice(0, MAX_NAV_CATEGORIES).map((c) => ({
    label: categoryLabel(c.category),
    href: `${base}/products?category=${encodeURIComponent(c.category)}`,
  }));
  const links: StorefrontNavLink[] = [];
  if (categoryLinks.length === 1) {
    // A dropdown with a single item is just a worse version of the link
    // itself — only bundle once there's actually more than one to pick from.
    links.push(categoryLinks[0]);
  } else if (categoryLinks.length > 1) {
    links.push({ label: "Categories", href: `${base}/products`, children: categoryLinks });
  }
  links.push({ label: "Shop all", href: `${base}/products` });
  // A store with nothing published yet gets no "Blog" link — it would only
  // ever lead to an empty page.
  if (opts.blog) links.push({ label: "Blog", href: `${base}/blog` });
  links.push({ label: "Sale", href: `${home}#sale` });
  if (opts.about) links.push({ label: "About", href: `${home}#about` });
  // Custom pages (Contact Us, FAQ, ...) created through the EcomAI chat.
  for (const p of opts.pages ?? []) links.push({ label: p.title, href: `${base}/${p.slug}` });
  return links;
}

/** A single storefront product, or null if it isn't approved/published here. */
export async function getStoreProduct(
  storeId: string,
  productId: string,
): Promise<ApiProduct | null> {
  const db = admin();
  if (!db) return null;
  const listed = await approvedListings(db, storeId, [productId]);
  if (!listed.has(productId)) return null;

  const { data } = await db
    .from("products")
    .select(PRODUCT_COLUMNS)
    .eq("id", productId)
    .eq("status", "published")
    .maybeSingle();
  if (!data) return null;
  return toApiProduct(data, listed.get(productId));
}

/**
 * Multiple approved+published products by id, in the order requested — the
 * data behind a curated "Best sellers" section on the custom storefront.
 * Silently drops ids that are no longer approved/published rather than
 * rendering a hole: a section a merchant curated shouldn't break because one
 * pick got delisted.
 */
export async function getStoreProductsByIds(storeId: string, ids: string[]): Promise<ApiProduct[]> {
  const db = admin();
  if (!db || !ids.length) return [];
  const listed = await approvedListings(db, storeId, ids);
  const approvedIds = [...listed.keys()];
  if (!approvedIds.length) return [];

  const { data } = await db
    .from("products")
    .select(PRODUCT_COLUMNS)
    .in("id", approvedIds)
    .eq("status", "published");
  const byId = new Map((data ?? []).map((p) => [p.id, p]));

  return ids.flatMap((id) => {
    const p = byId.get(id);
    return p ? [toApiProduct(p, listed.get(id))] : [];
  });
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export type RawLine = { productId: string; quantity: number };

const cartCookieName = (storeId: string) => `es_cart_${storeId}`;

/** Read the raw cart (ids + quantities only) from the cookie. */
export async function readCart(storeId: string): Promise<RawLine[]> {
  const jar = await cookies();
  const raw = jar.get(cartCookieName(storeId))?.value;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((l) => l as { p?: unknown; q?: unknown })
      .filter((l) => typeof l.p === "string" && typeof l.q === "number")
      .map((l) => ({ productId: l.p as string, quantity: Math.trunc(l.q as number) }))
      .filter((l) => l.quantity > 0)
      .slice(0, 100);
  } catch {
    return [];
  }
}

/** Persist the cart. Nothing sensitive lives here — only ids and quantities. */
export async function writeCart(storeId: string, lines: RawLine[]): Promise<void> {
  const jar = await cookies();
  const name = cartCookieName(storeId);
  if (!lines.length) {
    jar.delete(name);
    return;
  }
  jar.set(name, JSON.stringify(lines.map((l) => ({ p: l.productId, q: l.quantity }))), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: CART_COOKIE_DAYS * 24 * 60 * 60,
  });
}

/**
 * Price a set of raw lines against the store's approved catalog.
 *
 * Anything no longer purchasable is dropped and reported rather than silently
 * ignored, so the storefront can tell the customer what changed.
 */
export async function priceCart(storeId: string, lines: RawLine[]): Promise<PricedCart> {
  const empty: PricedCart = {
    lines: [],
    subtotal: 0,
    itemCount: 0,
    currency: "usd",
    removed: [],
    adjusted: [],
  };
  const db = admin();
  if (!db || !lines.length) return empty;

  const ids = [...new Set(lines.map((l) => l.productId))];
  const listed = await approvedListings(db, storeId, ids);
  const { data: prods } = await db
    .from("products")
    .select(PRODUCT_COLUMNS)
    .in("id", ids)
    .eq("status", "published");
  const byId = new Map((prods ?? []).map((p) => [p.id, p]));

  const out: PricedCart = { ...empty, lines: [], removed: [], adjusted: [] };

  for (const line of lines) {
    const product = byId.get(line.productId);
    if (!product || !listed.has(line.productId)) {
      out.removed.push({ productId: line.productId, reason: "unavailable" });
      continue;
    }
    const api = toApiProduct(product, listed.get(line.productId));
    if (api.available <= 0) {
      out.removed.push({ productId: line.productId, reason: "out_of_stock" });
      continue;
    }
    const unitPrice = api.price ?? 0;
    if (unitPrice <= 0) {
      out.removed.push({ productId: line.productId, reason: "unavailable" });
      continue;
    }

    if (!Number.isFinite(line.quantity) || line.quantity < 1) {
      // A zero or negative quantity is a malformed line, not a request for
      // one unit — it used to be silently bumped to 1 and reported as
      // "adjusted", which is how a customer ends up buying something they
      // tried to remove.
      out.removed.push({ productId: line.productId, reason: "unavailable" });
      continue;
    }
    const wanted = Math.min(line.quantity, MAX_LINE_QTY);
    const quantity = Math.min(wanted, api.available);
    if (quantity !== line.quantity) out.adjusted.push({ productId: line.productId, to: quantity });

    out.lines.push({
      productId: api.id,
      title: api.title,
      image: api.image,
      unitPrice,
      quantity,
      lineTotal: Math.round(unitPrice * quantity * 100) / 100,
      available: api.available,
    });
  }

  out.subtotal = Math.round(out.lines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100;
  out.itemCount = out.lines.reduce((s, l) => s + l.quantity, 0);
  return out;
}

/** Apply a mutation to the stored cart and return the re-priced result. */
export async function mutateCart(
  storeId: string,
  change: { productId: string; quantity: number; mode: "set" | "add" },
): Promise<PricedCart> {
  const current = await readCart(storeId);
  const idx = current.findIndex((l) => l.productId === change.productId);
  const next = [...current];

  const qty =
    change.mode === "add" ? (idx >= 0 ? next[idx].quantity : 0) + change.quantity : change.quantity;

  if (qty <= 0) {
    if (idx >= 0) next.splice(idx, 1);
  } else if (idx >= 0) {
    next[idx] = { ...next[idx], quantity: Math.min(qty, MAX_LINE_QTY) };
  } else {
    next.push({ productId: change.productId, quantity: Math.min(qty, MAX_LINE_QTY) });
  }

  const priced = await priceCart(storeId, next);
  // Persist what survived pricing, so a dropped line doesn't linger in the jar.
  await writeCart(
    storeId,
    priced.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
  );
  return priced;
}

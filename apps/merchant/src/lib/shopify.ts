import crypto from "node:crypto";
import { escapeHtml } from "@/lib/notify";

export const SHOPIFY_API_VERSION = "2026-10";

/** A GraphQL Admin API caller bound to a shop + access token. */
export function shopifyGraphql(shop: string, token: string) {
  return async function <T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    return res.json() as Promise<T>;
  };
}

/** Verify a Shopify webhook HMAC against the app's API secret. */
export function verifyShopifyHmac(rawBody: string, hmacHeader: string | null, secret: string): boolean {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

type PushProduct = {
  title: string;
  price: number | null;
  description?: string | null;
  sku?: string | null;
  /** Units the supplier has available; enables tracking and seeds the quantity. */
  inventory?: number | null;
  /** Public image URLs. Shopify fetches these itself, asynchronously. */
  images?: string[];
};

/** Shopify caps product media; more than this is noise on a storefront anyway. */
const MAX_MEDIA = 10;

function mediaInput(p: PushProduct) {
  return (p.images ?? []).slice(0, MAX_MEDIA).map((url) => ({
    originalSource: url,
    mediaContentType: "IMAGE",
    alt: p.title,
  }));
}

/**
 * `productCreate` no longer accepts variants inline — `ProductInput.variants`
 * was removed, and the argument is now `product: ProductCreateInput!`. The old
 * call failed at the GraphQL layer, which put the message in the top-level
 * `errors` array rather than `userErrors`; because the code only inspected
 * `userErrors` it counted every failure as a success and reported "pushed N
 * products" into a shop that received none.
 */
const PRODUCT_CREATE = `
mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
  productCreate(product: $product, media: $media) {
    product { id handle variants(first: 1) { nodes { id } } }
    userErrors { field message }
  }
}`;

/** Attach images to a product that already exists (backfill path). */
const PRODUCT_CREATE_MEDIA = `
mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    mediaUserErrors { field message }
  }
}`;

type MediaResp = {
  data?: { productCreateMedia?: { mediaUserErrors?: { message: string }[] } };
  errors?: { message: string }[];
};

/**
 * Add images to products that were pushed before media was wired up.
 *
 * Without this the only fix would be deleting every product and re-syncing.
 */
export async function backfillProductMedia(
  shop: string,
  token: string,
  items: { productId: string; title: string; images: string[] }[],
): Promise<{ updated: number; errors: string[] }> {
  const gql = shopifyGraphql(shop, token);
  let updated = 0;
  const errors: string[] = [];
  for (const it of items) {
    const media = mediaInput({ title: it.title, price: null, images: it.images });
    if (!media.length) continue;
    try {
      const res = await gql<MediaResp>(PRODUCT_CREATE_MEDIA, { productId: it.productId, media });
      const errs = collectErrors(res.data?.productCreateMedia?.mediaUserErrors, res.errors);
      if (errs.length) errors.push(`${it.title}: ${errs.join("; ")}`);
      else updated += 1;
    } catch (e) {
      errors.push(`${it.title}: ${e instanceof Error ? e.message : "media push failed"}`);
    }
  }
  return { updated, errors };
}

/** Price, SKU and inventory tracking land on the auto-created default variant. */
const VARIANTS_UPDATE = `
mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id inventoryItem { id } }
    userErrors { field message }
  }
}`;

const PUBLICATIONS = `{ publications(first: 25) { nodes { id name } } }`;

const PUBLISHABLE_PUBLISH = `
mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    userErrors { field message }
  }
}`;

/**
 * The Online Store publication id, or null when read_publications isn't granted.
 *
 * A product created through the API is NOT on any sales channel by default —
 * `publishedAt` stays null and the storefront never shows it, even though it
 * looks fine in admin. Publishing to this channel is what makes it visible.
 */
export async function fetchOnlineStorePublicationId(
  shop: string,
  token: string,
): Promise<string | null> {
  try {
    const res = await shopifyGraphql(shop, token)<{
      data?: { publications?: { nodes?: { id: string; name: string }[] } };
    }>(PUBLICATIONS);
    const nodes = res.data?.publications?.nodes ?? [];
    return nodes.find((n) => /online store/i.test(n.name))?.id ?? null;
  } catch {
    return null;
  }
}

/** Seeding a quantity needs a location, which needs the read_locations scope. */
const INVENTORY_ITEM_TRACK = `
mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
  inventoryItemUpdate(id: $id, input: $input) {
    inventoryItem { id tracked }
    userErrors { field message }
  }
}`;

const LOCATIONS = `{
  locations(first: 25, includeInactive: false) {
    nodes { id name isActive fulfillsOnlineOrders shipsInventory }
  }
}`;

/**
 * Shopify requires a field-level `@idempotent` directive on this mutation (it
 * rejects the call outright without one), and the key has to be unique per
 * call — so the document is built per invocation rather than being a constant.
 * The directive is only valid on the field, not the operation.
 */
const inventorySetDoc = () => `
mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) @idempotent(key: "${crypto.randomUUID()}") {
    inventoryAdjustmentGroup { createdAt }
    userErrors { field message }
  }
}`;

/**
 * The shop's primary location, or null when the token predates the
 * read_locations scope. Null means we still enable tracking but can't seed a
 * quantity — better than failing the whole product push over it.
 */
export type ShopLocation = {
  id: string;
  name: string;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
  shipsInventory: boolean;
};

/** Every active location on the shop, in Shopify's own order. */
export async function fetchLocations(shop: string, token: string): Promise<ShopLocation[]> {
  try {
    const res = await shopifyGraphql(shop, token)<{
      data?: { locations?: { nodes?: ShopLocation[] } };
    }>(LOCATIONS);
    return res.data?.locations?.nodes ?? [];
  } catch {
    return [];
  }
}

/**
 * The location stock should be written to.
 *
 * Not simply the first one: a shop can have several, and stock at a location
 * that doesn't fulfil online orders is invisible to the storefront — the
 * product reads as out of stock while Shopify admin shows units on hand. Two
 * shops with identical products then behave differently purely because of how
 * their locations are configured.
 *
 * Falls back to the first active location so a shop with none marked for
 * online orders still gets its stock somewhere rather than nowhere.
 */
export async function fetchPrimaryLocation(shop: string, token: string): Promise<string | null> {
  const locations = await fetchLocations(shop, token);
  if (!locations.length) return null;
  return (
    locations.find((l) => l.isActive && l.fulfillsOnlineOrders && l.shipsInventory) ??
    locations.find((l) => l.isActive && l.fulfillsOnlineOrders) ??
    locations.find((l) => l.isActive) ??
    locations[0]
  ).id;
}

type GraphqlError = { message: string };
type ProductCreateResp = {
  data?: {
    productCreate?: {
      product?: { id: string; handle?: string | null; variants?: { nodes?: { id: string }[] } } | null;
      userErrors?: { message: string }[];
    };
  };
  errors?: GraphqlError[];
};
type VariantsResp = {
  data?: {
    productVariantsBulkUpdate?: {
      productVariants?: { id: string; inventoryItem?: { id: string } | null }[];
      userErrors?: { message: string }[];
    };
  };
  errors?: GraphqlError[];
};
type PublishResp = {
  data?: { publishablePublish?: { userErrors?: { message: string }[] } };
  errors?: GraphqlError[];
};
type InventoryResp = {
  data?: { inventorySetQuantities?: { userErrors?: { message: string }[] } };
  errors?: GraphqlError[];
};

/** Collect both userErrors and top-level GraphQL errors — either can be fatal. */
function collectErrors(
  userErrors: { message: string }[] | undefined,
  topLevel: GraphqlError[] | undefined,
): string[] {
  return [...(userErrors ?? []).map((e) => e.message), ...(topLevel ?? []).map((e) => e.message)];
}


const INVENTORY_ACTIVATE = `
mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int) {
  inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) {
    inventoryLevel { id quantities(names: ["available"]) { name quantity } }
    userErrors { field message }
  }
}`;

const INVENTORY_LEVELS = `
query inventoryLevels($id: ID!) {
  inventoryItem(id: $id) {
    inventoryLevels(first: 20) {
      nodes { location { id } quantities(names: ["available"]) { name quantity } }
    }
  }
}`;

type LevelsResp = {
  data?: {
    inventoryItem?: {
      inventoryLevels?: {
        nodes?: {
          location?: { id: string } | null;
          quantities?: { name: string; quantity: number }[];
        }[];
      };
    } | null;
  };
  errors?: GraphqlError[];
};

type ActivateResp = {
  data?: { inventoryActivate?: { userErrors?: { message: string }[] } };
  errors?: GraphqlError[];
};

/**
 * Set a variant's stock at a location, activating it there if it isn't already.
 *
 * `inventorySetQuantities` only works on an item already stocked at the
 * location. A product created through the API isn't reliably activated at one,
 * and the failure is a userError rather than a throw — which is how stock
 * silently stayed at zero while every push reported success. `inventoryActivate`
 * both stocks the item and seeds the quantity, so it's the right recovery.
 */
async function writeInventory(
  gql: ReturnType<typeof shopifyGraphql>,
  args: { inventoryItemId: string; locationId: string; quantity: number; changeFrom: number },
): Promise<string[]> {
  const quantity = Math.max(0, Math.trunc(args.quantity));

  const set = (changeFrom: number) =>
    gql<InventoryResp>(inventorySetDoc(), {
      input: {
        name: "available",
        reason: "correction",
        quantities: [
          {
            inventoryItemId: args.inventoryItemId,
            locationId: args.locationId,
            quantity,
            changeFromQuantity: changeFrom,
          },
        ],
      },
    });

  const first = await set(args.changeFrom);
  const errs = collectErrors(first.data?.inventorySetQuantities?.userErrors, first.errors);
  if (!errs.length) return [];

  // Both ways this fails look identical from the caller — a userError, not a
  // throw — so find out which it is rather than guessing.
  const levels = await gql<LevelsResp>(INVENTORY_LEVELS, { id: args.inventoryItemId });
  const here = levels.data?.inventoryItem?.inventoryLevels?.nodes?.find(
    (n) => n.location?.id === args.locationId,
  );

  if (!here) {
    // Not stocked at this location: setQuantities can't reach it. Activate
    // stocks the item and seeds the quantity in one call.
    const activated = await gql<ActivateResp>(INVENTORY_ACTIVATE, {
      inventoryItemId: args.inventoryItemId,
      locationId: args.locationId,
      available: quantity,
    });
    const aErrs = collectErrors(activated.data?.inventoryActivate?.userErrors, activated.errors);
    return aErrs.length ? [...errs, ...aErrs] : [];
  }

  // Stocked, so the baseline was stale — retry against the real value.
  const actual = here.quantities?.find((q) => q.name === "available")?.quantity ?? 0;
  if (actual === quantity) return [];
  const retry = await set(actual);
  const rErrs = collectErrors(retry.data?.inventorySetQuantities?.userErrors, retry.errors);
  return rErrs.length ? [...errs, ...rErrs] : [];
}

/**
 * Push the AI-built catalog into a Shopify store: one product each, then the
 * price/SKU onto its default variant. `created` counts products Shopify
 * confirmed, never attempts.
 */
export async function pushProductsToShopify(
  shop: string,
  token: string,
  products: PushProduct[],
): Promise<{ created: number; errors: string[]; ids: Map<string, { id: string; handle: string | null }> }> {
  const gql = shopifyGraphql(shop, token);
  let created = 0;
  const errors: string[] = [];
  /** our product id (sent as the SKU) -> the Shopify product gid/handle it became. */
  const ids = new Map<string, { id: string; handle: string | null }>();

  // One lookup each for the whole batch. Null when the scope isn't granted.
  const locationId = await fetchPrimaryLocation(shop, token);
  if (!locationId) {
    errors.push(
      "Stock levels not set — couldn't read the shop's location. The app needs the read_locations scope (reconnect the store). Products are created and tracked but show 0 in stock.",
    );
  }
  const publicationId = await fetchOnlineStorePublicationId(shop, token);
  if (!publicationId) {
    errors.push(
      "Created, but not published to the Online Store — the app needs the read_publications/write_publications scopes (reinstall it). Products stay hidden from the storefront until then.",
    );
  }

  for (const p of products) {
    try {
      const res = await gql<ProductCreateResp>(PRODUCT_CREATE, {
        product: {
          title: p.title,
          descriptionHtml: p.description ? `<p>${escapeHtml(p.description)}</p>` : undefined,
          status: "ACTIVE",
        },
        media: mediaInput(p),
      });

      const createErrs = collectErrors(res.data?.productCreate?.userErrors, res.errors);
      const product = res.data?.productCreate?.product;
      if (!product?.id) {
        errors.push(`${p.title}: ${createErrs.join("; ") || "productCreate returned no product"}`);
        continue;
      }
      created += 1;
      if (p.sku) ids.set(p.sku, { id: product.id, handle: product.handle ?? null });

      // Without this the product exists in admin but never reaches the storefront.
      if (publicationId) {
        const pub = await gql<PublishResp>(PUBLISHABLE_PUBLISH, {
          id: product.id,
          input: [{ publicationId }],
        });
        const pErrs = collectErrors(pub.data?.publishablePublish?.userErrors, pub.errors);
        if (pErrs.length) errors.push(`${p.title} (publish): ${pErrs.join("; ")}`);
      }

      // A product with no price is still a product — record the problem but
      // don't discard the product we just created.
      const variantId = product.variants?.nodes?.[0]?.id;
      if (variantId) {
        const track = p.inventory != null;
        const vr = await gql<VariantsResp>(VARIANTS_UPDATE, {
          productId: product.id,
          variants: [
            {
              id: variantId,
              ...(p.price != null ? { price: String(p.price) } : {}),
              inventoryItem: {
                ...(p.sku ? { sku: p.sku } : {}),
                // Untracked variants show "Inventory not tracked" and always
                // read as purchasable; tracking mirrors the supplier's stock.
                ...(track ? { tracked: true } : {}),
              },
            },
          ],
        });
        const vErrs = collectErrors(vr.data?.productVariantsBulkUpdate?.userErrors, vr.errors);
        if (vErrs.length) errors.push(`${p.title} (variant): ${vErrs.join("; ")}`);

        const inventoryItemId =
          vr.data?.productVariantsBulkUpdate?.productVariants?.[0]?.inventoryItem?.id;
        if (track && !inventoryItemId) {
          errors.push(`${p.title} (stock): Shopify returned no inventory item for the variant`);
        }
        if (track && locationId && inventoryItemId) {
          // changeFrom 0: this runs immediately after productCreate, so the
          // current value is 0. Shopify rejects `available` without a baseline.
          const iErrs = await writeInventory(gql, {
            inventoryItemId,
            locationId,
            quantity: p.inventory ?? 0,
            changeFrom: 0,
          });
          if (iErrs.length) errors.push(`${p.title} (stock): ${iErrs.join("; ")}`);
        }
      }
    } catch (e) {
      errors.push(`${p.title}: ${e instanceof Error ? e.message : "product push failed"}`);
    }
  }
  return { created, errors, ids };
}

/**
 * What's already in the shop, from one pass over its variants.
 *
 * `productIds` is the authoritative check — a listing records the Shopify
 * product it became. `skuToProductId` is the fallback for listings created
 * before that column existed, and lets sync backfill them.
 */
export async function fetchShopCatalog(
  shop: string,
  token: string,
): Promise<{
  productIds: Set<string>;
  skuToProductId: Map<string, string>;
  /** Products in the shop with no images yet. */
  withoutMedia: Set<string>;
  /** Products whose stock was never applied — variant inventory is untracked. */
  untracked: Map<string, { inventoryItemId: string }>;
}> {
  const gql = shopifyGraphql(shop, token);
  const productIds = new Set<string>();
  const skuToProductId = new Map<string, string>();
  const withoutMedia = new Set<string>();
  const untracked = new Map<string, { inventoryItemId: string }>();
  let cursor: string | null = null;

  // 250 is the page maximum; the loop is bounded so a pagination bug can't spin.
  for (let page = 0; page < 40; page++) {
    const res: {
      data?: {
        products?: {
          nodes?: {
            id: string;
            mediaCount?: { count: number } | null;
            variants?: {
              nodes?: {
                sku: string | null;
                inventoryItem?: { id: string; tracked: boolean } | null;
              }[];
            };
          }[];
          pageInfo?: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    } = await gql(
      `query shopCatalog($cursor: String) {
        products(first: 100, after: $cursor) {
          nodes {
            id
            mediaCount { count }
            variants(first: 5) { nodes { sku inventoryItem { id tracked } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { cursor },
    );
    const conn = res.data?.products;
    for (const p of conn?.nodes ?? []) {
      productIds.add(p.id);
      if ((p.mediaCount?.count ?? 0) === 0) withoutMedia.add(p.id);
      const first = p.variants?.nodes?.[0];
      if (first?.inventoryItem && !first.inventoryItem.tracked) {
        untracked.set(p.id, { inventoryItemId: first.inventoryItem.id });
      }
      for (const v of p.variants?.nodes ?? []) if (v.sku) skuToProductId.set(v.sku, p.id);
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return { productIds, skuToProductId, withoutMedia, untracked };
}

const DEFAULT_PROFILE = `
{
  deliveryProfiles(first: 5) {
    nodes {
      id
      default
      profileLocationGroups {
        locationGroup { id }
        locationGroupZones(first: 10) {
          nodes {
            zone { id name }
            methodDefinitions(first: 5) { nodes { id name active } }
          }
        }
      }
    }
  }
}`;

const DELIVERY_PROFILE_UPDATE = `
mutation deliveryProfileUpdate($id: ID!, $profile: DeliveryProfileInput!) {
  deliveryProfileUpdate(id: $id, profile: $profile) {
    profile { id }
    userErrors { field message }
  }
}`;

export type ShippingState = {
  /** Null when the read_shipping scope isn't granted. */
  hasRate: boolean | null;
  detail: string;
};

/** Does the store have any active shipping rate a customer could pick? */
export async function fetchShippingState(shop: string, token: string): Promise<ShippingState> {
  try {
    const res = await shopifyGraphql(shop, token)<{
      data?: {
        deliveryProfiles?: {
          nodes?: {
            default: boolean;
            profileLocationGroups?: {
              locationGroupZones?: {
                nodes?: { methodDefinitions?: { nodes?: { active: boolean }[] } }[];
              };
            }[];
          }[];
        };
      };
      errors?: { message: string }[];
    }>(DEFAULT_PROFILE);

    if (res.errors?.length) return { hasRate: null, detail: res.errors[0].message };

    const rates = (res.data?.deliveryProfiles?.nodes ?? []).flatMap((p) =>
      (p.profileLocationGroups ?? []).flatMap((g) =>
        (g.locationGroupZones?.nodes ?? []).flatMap((z) =>
          (z.methodDefinitions?.nodes ?? []).filter((m) => m.active),
        ),
      ),
    );
    return {
      hasRate: rates.length > 0,
      detail: rates.length
        ? `${rates.length} active rate${rates.length === 1 ? "" : "s"}`
        : "No shipping rate — checkout will block",
    };
  } catch (e) {
    return { hasRate: null, detail: e instanceof Error ? e.message : "couldn't read shipping" };
  }
}

/**
 * Give a new store a usable shipping rate.
 *
 * A store with products but no rate takes the customer all the way to checkout
 * and then refuses to complete, so provisioning seeds one. No-ops when a rate
 * already exists — we never overwrite what a merchant set up themselves.
 */
export async function ensureDefaultShippingRate(
  shop: string,
  token: string,
  opts: { amount?: number; countryCodes?: string[] } = {},
): Promise<{ created: boolean; note: string }> {
  const gql = shopifyGraphql(shop, token);

  const state = await fetchShippingState(shop, token);
  if (state.hasRate === null) return { created: false, note: `shipping not checked (${state.detail})` };
  if (state.hasRate) return { created: false, note: "shipping rate already set" };

  const res = await gql<{
    data?: {
      deliveryProfiles?: {
        nodes?: { id: string; default: boolean; profileLocationGroups?: { locationGroup: { id: string } }[] }[];
      };
    };
  }>(DEFAULT_PROFILE);
  const profile =
    res.data?.deliveryProfiles?.nodes?.find((p) => p.default) ?? res.data?.deliveryProfiles?.nodes?.[0];
  const groupId = profile?.profileLocationGroups?.[0]?.locationGroup?.id;
  if (!profile || !groupId) return { created: false, note: "no delivery profile to update" };

  const update = await gql<{
    data?: { deliveryProfileUpdate?: { userErrors?: { message: string }[] } };
    errors?: { message: string }[];
  }>(DELIVERY_PROFILE_UPDATE, {
    id: profile.id,
    profile: {
      locationGroupsToUpdate: [
        {
          id: groupId,
          zonesToCreate: [
            {
              name: "Standard shipping",
              countries: opts.countryCodes?.length
                ? opts.countryCodes.map((code) => ({ code }))
                : [{ restOfWorld: true }],
              methodDefinitionsToCreate: [
                {
                  name: "Standard",
                  active: true,
                  rateDefinition: {
                    price: { amount: String(opts.amount ?? 5), currencyCode: "USD" },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  });

  const errs = collectErrors(update.data?.deliveryProfileUpdate?.userErrors, update.errors);
  if (errs.length) return { created: false, note: `shipping rate failed: ${errs.join("; ")}` };
  return { created: true, note: "added a standard shipping rate" };
}

const PRODUCT_DELETE = `
mutation productDelete($input: ProductDeleteInput!) {
  productDelete(input: $input) { deletedProductId userErrors { message } }
}`;

const THEME_DELETE = `
mutation themeDelete($id: ID!) {
  themeDelete(id: $id) { deletedThemeId userErrors { message } }
}`;

/**
 * Strip EcomStrait's content off a shop before it returns to the pool.
 *
 * Releasing a store without this hands the next merchant the previous one's
 * products, images, theme and branding. Deliberately surgical: it removes only
 * the products we recorded creating and the theme we installed, so anything the
 * merchant added themselves is left alone rather than us wiping a shop we don't
 * fully own.
 */
export async function wipeStoreContent(
  shop: string,
  token: string,
  opts: { productIds: string[]; themeGid?: string | null },
): Promise<{ productsDeleted: number; themeDeleted: boolean; errors: string[] }> {
  const gql = shopifyGraphql(shop, token);
  const errors: string[] = [];
  let productsDeleted = 0;

  for (const id of opts.productIds) {
    try {
      const res = await gql<{
        data?: { productDelete?: { deletedProductId?: string | null; userErrors?: { message: string }[] } };
        errors?: { message: string }[];
      }>(PRODUCT_DELETE, { input: { id } });
      const errs = collectErrors(res.data?.productDelete?.userErrors, res.errors);
      // A product the merchant already deleted isn't a failure.
      if (res.data?.productDelete?.deletedProductId) productsDeleted += 1;
      else if (errs.length) errors.push(errs.join("; "));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "product delete failed");
    }
  }

  let themeDeleted = false;
  if (opts.themeGid) {
    try {
      const res = await gql<{
        data?: { themeDelete?: { deletedThemeId?: string | null; userErrors?: { message: string }[] } };
        errors?: { message: string }[];
      }>(THEME_DELETE, { id: opts.themeGid });
      themeDeleted = Boolean(res.data?.themeDelete?.deletedThemeId);
      const errs = collectErrors(res.data?.themeDelete?.userErrors, res.errors);
      if (!themeDeleted && errs.length) errors.push(errs.join("; "));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "theme delete failed");
    }
  }

  return { productsDeleted, themeDeleted, errors };
}

/**
 * Did this failure mean "the token is no longer valid"?
 *
 * Shopify reports it as a plain message rather than a typed code, so matching
 * the text is the only option. Used to turn a raw API error into a "reconnect
 * this store" state the merchant can act on.
 */
export function isShopifyAuthError(message: string | undefined | null): boolean {
  if (!message) return false;
  return /invalid api key or access token|unrecognized login|401|unauthorized/i.test(message);
}

/** Confirm a stored token still works, without mutating anything. */
export async function isTokenAlive(shop: string, token: string): Promise<boolean> {
  try {
    const res = await shopifyGraphql(shop, token)<{ data?: { shop?: { name?: string } } }>(
      `{ shop { name } }`,
    );
    return Boolean(res.data?.shop?.name);
  } catch {
    return false;
  }
}

/**
 * Apply stock to products already in the shop whose inventory was never set.
 *
 * Products pushed before inventory sync existed sit there untracked, and the
 * normal sync skips them because they're already present — so without this the
 * only fix is deleting and re-pushing every product. Only touches variants
 * Shopify reports as untracked, so a merchant's own stock edits are left alone.
 */
export async function backfillInventory(
  shop: string,
  token: string,
  items: { inventoryItemId: string; title: string; quantity: number }[],
): Promise<{ updated: number; errors: string[] }> {
  const gql = shopifyGraphql(shop, token);
  const errors: string[] = [];
  let updated = 0;

  const locationId = await fetchPrimaryLocation(shop, token);
  if (!locationId) {
    return {
      updated: 0,
      errors: items.length
        ? ["Couldn't read the shop's location, so stock levels weren't applied."]
        : [],
    };
  }

  for (const item of items) {
    try {
      const track = await gql<VariantsResp>(INVENTORY_ITEM_TRACK, {
        id: item.inventoryItemId,
        input: { tracked: true },
      });
      const tErrs = collectErrors(undefined, track.errors);
      if (tErrs.length) {
        errors.push(`${item.title} (stock): ${tErrs.join("; ")}`);
        continue;
      }

      // Untracked variants read as 0 until tracking is switched on above.
      const iErrs = await writeInventory(gql, {
        inventoryItemId: item.inventoryItemId,
        locationId,
        quantity: item.quantity,
        changeFrom: 0,
      });
      if (iErrs.length) errors.push(`${item.title} (stock): ${iErrs.join("; ")}`);
      else updated += 1;
    } catch (e) {
      errors.push(`${item.title}: ${e instanceof Error ? e.message : "stock update failed"}`);
    }
  }
  return { updated, errors };
}

const PRODUCT_UPDATE = `
mutation productUpdate($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id }
    userErrors { field message }
  }
}`;

const PRODUCT_STOCK_STATE = `
query productStock($id: ID!) {
  product(id: $id) {
    id
    mediaCount { count }
    variants(first: 1) {
      nodes {
        id
        inventoryItem {
          id
          tracked
          inventoryLevels(first: 1) {
            nodes { location { id } quantities(names: ["available"]) { name quantity } }
          }
        }
      }
    }
  }
}`;

/** Push title/description onto a product that already exists in the shop. */
export async function updateShopifyProductContent(
  shop: string,
  token: string,
  productGid: string,
  content: { title: string; description?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const gql = shopifyGraphql(shop, token);
  try {
    const res = await gql<{
      data?: { productUpdate?: { userErrors?: { message: string }[] } };
      errors?: GraphqlError[];
    }>(PRODUCT_UPDATE, {
      product: {
        id: productGid,
        title: content.title,
        descriptionHtml: content.description ? `<p>${escapeHtml(content.description)}</p>` : "",
      },
    });
    const errs = collectErrors(res.data?.productUpdate?.userErrors, res.errors);
    return errs.length ? { ok: false, error: errs.join("; ") } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "product update failed" };
  }
}

/**
 * Set a product's stock in the shop to an absolute number.
 *
 * Reads the current quantity first because `inventorySetQuantities` requires
 * `changeFromQuantity` to match what's on record — passing a stale 0 fails
 * against a product that has already sold units.
 */
export async function setShopifyProductStock(
  shop: string,
  token: string,
  productGid: string,
  quantity: number,
): Promise<{ ok: boolean; error?: string; mediaCount?: number }> {
  const gql = shopifyGraphql(shop, token);
  try {
    const state = await gql<{
      data?: {
        product?: {
          mediaCount?: { count: number } | null;
          variants?: {
            nodes?: {
              inventoryItem?: {
                id: string;
                tracked: boolean;
                inventoryLevels?: {
                  nodes?: {
                    location: { id: string };
                    quantities?: { name: string; quantity: number }[];
                  }[];
                };
              } | null;
            }[];
          };
        } | null;
      };
      errors?: GraphqlError[];
    }>(PRODUCT_STOCK_STATE, { id: productGid });

    const item = state.data?.product?.variants?.nodes?.[0]?.inventoryItem;
    const mediaCount = state.data?.product?.mediaCount?.count;
    if (!item) return { ok: false, error: "product has no inventory item", mediaCount };

    const level = item.inventoryLevels?.nodes?.[0];
    const locationId = level?.location?.id ?? (await fetchPrimaryLocation(shop, token));
    if (!locationId) return { ok: false, error: "couldn't resolve a location", mediaCount };

    if (!item.tracked) {
      await gql(INVENTORY_ITEM_TRACK, { id: item.id, input: { tracked: true } });
    }

    const current =
      level?.quantities?.find((q) => q.name === "available")?.quantity ?? 0;
    const target = Math.max(0, Math.trunc(quantity));
    if (current === target) return { ok: true, mediaCount };

    const errs = await writeInventory(gql, {
      inventoryItemId: item.id,
      locationId,
      quantity: target,
      changeFrom: current,
    });
    return errs.length ? { ok: false, error: errs.join("; "), mediaCount } : { ok: true, mediaCount };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "stock update failed" };
  }
}

const PRODUCT_STATUS_UPDATE = `
mutation productStatus($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id status }
    userErrors { field message }
  }
}`;

const PRODUCT_VARIANT_ID = `
query productVariant($id: ID!) {
  product(id: $id) { variants(first: 1) { nodes { id price } } }
}`;

const VARIANT_PRICE_UPDATE = `
mutation variantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price }
    userErrors { field message }
  }
}`;

/**
 * Show or hide a product on the shop's storefront.
 *
 * DRAFT rather than delete: a supplier unpublishing is usually temporary, and
 * deleting would throw away the `shopify_product_id` that links the listing
 * back to us — republishing would then have to create a new product and lose
 * its URL, reviews and analytics.
 */
export async function setShopifyProductStatus(
  shop: string,
  token: string,
  productGid: string,
  status: "ACTIVE" | "DRAFT",
): Promise<{ ok: boolean; error?: string }> {
  const gql = shopifyGraphql(shop, token);
  try {
    const res = await gql<{
      data?: { productUpdate?: { userErrors?: { message: string }[] } };
      errors?: GraphqlError[];
    }>(PRODUCT_STATUS_UPDATE, { product: { id: productGid, status } });
    const errs = collectErrors(res.data?.productUpdate?.userErrors, res.errors);
    return errs.length ? { ok: false, error: errs.join("; ") } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "status update failed" };
  }
}

/** Set the selling price on a product's variant, skipping a no-op write. */
export async function setShopifyProductPrice(
  shop: string,
  token: string,
  productGid: string,
  price: number,
): Promise<{ ok: boolean; error?: string }> {
  const gql = shopifyGraphql(shop, token);
  const amount = (Math.round(price * 100) / 100).toFixed(2);
  try {
    const found = await gql<{
      data?: { product?: { variants?: { nodes?: { id: string; price: string }[] } } | null };
      errors?: GraphqlError[];
    }>(PRODUCT_VARIANT_ID, { id: productGid });

    const variant = found.data?.product?.variants?.nodes?.[0];
    if (!variant) return { ok: false, error: "product has no variant" };
    if (Number(variant.price) === Number(amount)) return { ok: true };

    const res = await gql<{
      data?: { productVariantsBulkUpdate?: { userErrors?: { message: string }[] } };
      errors?: GraphqlError[];
    }>(VARIANT_PRICE_UPDATE, {
      productId: productGid,
      variants: [{ id: variant.id, price: amount }],
    });
    const errs = collectErrors(res.data?.productVariantsBulkUpdate?.userErrors, res.errors);
    return errs.length ? { ok: false, error: errs.join("; ") } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "price update failed" };
  }
}

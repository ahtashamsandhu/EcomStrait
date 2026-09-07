import { NextResponse } from "next/server";
import { verifyInternalRequest } from "@/lib/secret-compare";
import { propagateProduct, cascadeSupplierPrice } from "@/lib/product-propagation";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Push a supplier's current product state out to every Shopify store selling it.
 *
 * The supplier portal calls this after an edit or a stock change: Shopify
 * credentials live only in this app, so it stays the one place that talks to
 * Shopify. Same shared secret as /api/internal/list-product.
 *
 * A product listed on ten stores means ten shops to update, so callers should
 * treat this as best-effort and never block a save on it.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyInternalRequest(req, raw)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    productId?: string;
    productIds?: string[];
    content?: boolean;
    stock?: boolean;
    price?: boolean;
    status?: boolean;
    /** The retail price before the supplier's edit; drives the price cascade. */
    previousPrice?: number | null;
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const ids = [
    ...new Set(
      [...(body.productIds ?? []), body.productId]
        .map((i) => i?.trim())
        .filter((i): i is string => Boolean(i)),
    ),
  ];
  if (!ids.length) {
    return NextResponse.json({ error: "productId or productIds required" }, { status: 400 });
  }

  // Default to everything: a caller that says nothing means "make the stores
  // match what we hold".
  const content = body.content ?? true;
  const stock = body.stock ?? true;
  const price = body.price ?? true;
  const status = body.status ?? true;

  let stores = 0;
  let updated = 0;
  let followed = 0;
  let kept = 0;
  const errors: string[] = [];
  for (const id of ids.slice(0, 100)) {
    // Move listing prices first, so the push below sends the new numbers.
    // This is also what fixes custom-website storefronts, which read
    // `store_products.price` directly and never see a Shopify push.
    if (price) {
      const c = await cascadeSupplierPrice(id, body.previousPrice);
      followed += c.followed;
      kept += c.kept;
    }
    const res = await propagateProduct(id, { content, stock, price, status });
    stores += res.stores;
    updated += res.updated;
    errors.push(...res.errors);
  }

  if (errors.length) console.error("[sync-product]", errors.slice(0, 5).join("; "));
  return NextResponse.json({ stores, updated, followed, kept, errors: errors.slice(0, 10) });
}

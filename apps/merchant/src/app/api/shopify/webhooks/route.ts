import { NextResponse, after } from "next/server";
import { createAdminClient } from "@ecomstrait/db/admin";
import { verifyShopifyHmac } from "@/lib/shopify";
import { recordCustomerOrder, reverseCustomerOrder, type SoldItem } from "@/lib/order-sink";
import { checkRestockAfterSale } from "@/lib/restock-check";

type ShopifyLine = { title?: string | null; quantity: number; price: string; sku?: string | null };
type ShopifyOrder = {
  id: number;
  line_items: ShopifyLine[];
  customer?: { first_name?: string; last_name?: string; email?: string; phone?: string | null };
  email?: string;
  phone?: string | null;
  shipping_address?: Record<string, string | null>;
  financial_status?: string;
  payment_gateway_names?: string[];
  test?: boolean;
  cancelled_at?: string | null;
};

const PAID_STATUSES = new Set(["paid", "partially_paid"]);

/**
 * Shopify has no explicit "is this COD" flag. A merchant-enabled Cash on
 * Delivery method shows up as a gateway name — that's the decisive signal,
 * matched loosely ("cash on delivery" / "cod") since gateway names aren't a
 * fixed enum and different COD apps/plugins name theirs differently.
 * `financial_status` alone is deliberately NOT used as a trigger: it also
 * reads `pending` for other reasons (manual payment terms, bank transfer),
 * so treating "pending" as "COD" would misroute a merchant's wallet debit
 * onto the supplier's for an order that was never COD.
 */
function derivePaymentType(order: ShopifyOrder): "prepaid" | "cod" {
  const gateways = (order.payment_gateway_names ?? []).map((g) => g.toLowerCase());
  const looksLikeCod = gateways.some((g) => g.includes("cash on delivery") || g.includes("cod"));
  return looksLikeCod ? "cod" : "prepaid";
}

function fmtShippingAddr(a?: Record<string, string | null>): string | null {
  if (!a) return null;
  const parts = [
    a.name,
    a.company,
    [a.address1, a.address2].filter(Boolean).join(" "),
    [a.city, a.province, a.zip].filter(Boolean).join(" "),
    a.country,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export async function POST(req: Request) {
  const secret = process.env.SHOPIFY_API_SECRET;
  const hmac = req.headers.get("x-shopify-hmac-sha256");
  const topic = req.headers.get("x-shopify-topic");
  const shop = req.headers.get("x-shopify-shop-domain");
  const raw = await req.text();

  if (!secret || !verifyShopifyHmac(raw, hmac, secret)) {
    return NextResponse.json({ error: "Invalid HMAC" }, { status: 401 });
  }

  if (!shop) return NextResponse.json({ ok: true });
  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ ok: true });

  if (topic === "orders/cancelled") {
    const cancelled = JSON.parse(raw) as ShopifyOrder;
    if (!cancelled.test) {
      await reverseCustomerOrder(admin, `shopify:${cancelled.id}`, "Shopify order cancelled");
    }
    return NextResponse.json({ ok: true });
  }

  // orders/create fires for every order, paid or not; orders/paid fires once
  // the money is actually in. A prepaid order is recorded (and the merchant's
  // wallet debited) only from a paid state — an abandoned "pending" checkout
  // or a manual-payment order must never charge anyone. COD orders are
  // pending by definition and are recorded on create. Test orders never are.
  if (topic !== "orders/create" && topic !== "orders/paid") return NextResponse.json({ ok: true });
  const order = JSON.parse(raw) as ShopifyOrder;
  if (order.test || order.cancelled_at) return NextResponse.json({ ok: true });
  const paymentType = derivePaymentType(order);
  if (paymentType === "prepaid" && !PAID_STATUSES.has(order.financial_status ?? "")) {
    return NextResponse.json({ ok: true });
  }

  // shop → dev-store pool row → the merchant's store
  const { data: pool } = await admin.from("shopify_stores").select("id").eq("shop_domain", shop).maybeSingle();
  if (!pool) return NextResponse.json({ ok: true });
  const { data: store } = await admin.from("stores").select("id").eq("shopify_store_id", pool.id).maybeSingle();
  if (!store) return NextResponse.json({ ok: true });

  // Map Shopify line items to our products/suppliers (by title, via store_products).
  const { data: sp } = await admin.from("store_products").select("product_id").eq("store_id", store.id);
  const ids = (sp ?? []).map((r) => r.product_id);
  const { data: prods } = ids.length
    ? await admin.from("products").select("id, title, supplier_id").in("id", ids)
    : { data: [] };
  const byId = new Map((prods ?? []).map((p) => [p.id, p]));
  const byTitle = new Map((prods ?? []).map((p) => [p.title.toLowerCase().trim(), p]));

  const items: SoldItem[] = (order.line_items ?? []).map((li) => {
    const title = (li.title ?? "").trim();
    // We push products with sku = our product id, so match by SKU first.
    const match = (li.sku && byId.get(li.sku)) || byTitle.get(title.toLowerCase());
    return {
      product_id: match?.id ?? null,
      supplier_id: match?.supplier_id ?? null,
      name: title || "Product",
      quantity: Math.max(1, Math.trunc(Number(li.quantity) || 1)),
      unit_price: li.price ? Number(li.price) : null,
    };
  });

  const name = [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ") || null;

  await recordCustomerOrder(admin, {
    storeId: store.id,
    externalId: `shopify:${order.id}`,
    paymentType,
    customerName: name,
    customerEmail: order.customer?.email ?? order.email ?? null,
    // Prefer the shipping address's own phone (most relevant to delivery),
    // falling back to the order- and customer-level phone Shopify also sends.
    customerPhone: order.shipping_address?.phone ?? order.phone ?? order.customer?.phone ?? null,
    shipping: fmtShippingAddr(order.shipping_address),
    items,
  });

  // Phase 6 (Docs/AI-Native-Migration-Plan.md): the restock check runs
  // in-process, not via an external workflow tool — it's one function call
  // entirely within our own DB and Shopify integration, the same reasoning
  // that already keeps the orchestrator calling Shopify tools directly
  // instead of round-tripping through the MCP HTTP endpoint. `after()` — not
  // a bare unawaited call — is what makes this safe on Vercel: a
  // fire-and-forget promise with no `await` can be frozen or torn down the
  // moment the response returns, since a serverless function's lifecycle
  // isn't guaranteed to outlive its response.
  after(() => checkRestockAfterSale(items).catch((err) => console.error("[restock-check] failed:", err)));

  return NextResponse.json({ ok: true });
}

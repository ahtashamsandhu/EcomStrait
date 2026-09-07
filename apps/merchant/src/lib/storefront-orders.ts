import { createAdminClient } from "@ecomstrait/db/admin";
import { getStripe } from "@/lib/stripe";
import { recordCustomerOrder } from "@/lib/order-sink";

/**
 * Order confirmation for the storefront.
 *
 * Shared by the success page and the orders API so a customer order is recorded
 * exactly once, whichever gets there first — `recordCustomerOrder` is
 * idempotent on the Stripe session id.
 */

export type OrderItemView = {
  productId: string | null;
  name: string;
  quantity: number;
  unitPrice: number | null;
};

export type OrderView = {
  id: string;
  status: string;
  subtotal: number | null;
  customerName: string | null;
  customerEmail: string | null;
  shipping: string | null;
  items: OrderItemView[];
  createdAt: string;
};

type Addr = { name?: string | null; address?: Record<string, string | null> | null };

function formatAddr(d: Addr | null | undefined): string | null {
  if (!d) return null;
  const a = d.address ?? {};
  const parts = [
    d.name,
    [a.line1, a.line2].filter(Boolean).join(" "),
    [a.city, a.state, a.postal_code].filter(Boolean).join(" "),
    a.country,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

type StoredItem = {
  product_id?: string | null;
  name?: string;
  quantity?: number;
  unit_price?: number | null;
};

function toView(row: {
  id: string;
  status: string;
  subtotal: number | null;
  customer_name: string | null;
  customer_email: string | null;
  shipping: string | null;
  items: unknown;
  created_at: string;
}): OrderView {
  const items = Array.isArray(row.items) ? (row.items as StoredItem[]) : [];
  return {
    id: row.id,
    status: row.status,
    subtotal: row.subtotal,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    shipping: row.shipping,
    items: items.map((i) => ({
      productId: i.product_id ?? null,
      name: i.name ?? "Product",
      quantity: i.quantity ?? 1,
      unitPrice: i.unit_price ?? null,
    })),
    createdAt: row.created_at,
  };
}

const ORDER_COLUMNS =
  "id, status, subtotal, customer_name, customer_email, shipping, items, created_at";

/** An already-recorded order for this store + session. */
export async function getOrderBySession(
  storeId: string,
  sessionId: string,
): Promise<OrderView | null> {
  const admin = createAdminClient();
  if (!admin) return null;
  const { data } = await admin
    .from("store_orders")
    .select(ORDER_COLUMNS)
    .eq("store_id", storeId)
    .eq("stripe_session_id", sessionId)
    .maybeSingle();
  return data ? toView(data) : null;
}

/**
 * Record a paid Stripe session as an order (idempotent), then return it.
 * Returns null when the session isn't paid or can't be read.
 */
export async function confirmOrder(
  storeId: string,
  sessionId: string,
): Promise<OrderView | null> {
  const existing = await getOrderBySession(storeId, sessionId);
  if (existing) return existing;

  const stripe = getStripe();
  const admin = createAdminClient();
  if (!stripe || !admin) return null;

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  // Only a session this app created for THIS store confirms here — anything
  // without our store_id (or with another store's) is not ours to record.
  if (session.metadata?.store_id !== storeId) return null;
  if (session.payment_status !== "paid") return null;

  // What was actually bought, at the price actually paid — straight from the
  // Stripe line items, not re-derived from today's catalog price.
  const lineItems = await stripe.checkout.sessions.listLineItems(sessionId, {
    limit: 100,
    expand: ["data.price.product"],
  });
  const lines = lineItems.data
    .map((li) => {
      const product = li.price?.product;
      const productId =
        product && typeof product === "object" && "metadata" in product ? product.metadata?.product_id : undefined;
      return {
        productId: productId ?? null,
        quantity: Math.max(1, li.quantity ?? 1),
        unitPrice: li.price?.unit_amount != null ? li.price.unit_amount / 100 : null,
        name: li.description ?? "Product",
      };
    })
    .filter((l): l is typeof l & { productId: string } => Boolean(l.productId));
  const ids = lines.map((l) => l.productId);
  if (!ids.length) return null;

  const { data: prods } = await admin.from("products").select("id, title, supplier_id").in("id", ids);

  const items = lines.map((l) => {
    const p = (prods ?? []).find((x) => x.id === l.productId);
    return {
      product_id: l.productId,
      supplier_id: p?.supplier_id ?? null,
      name: p?.title ?? l.name,
      quantity: l.quantity,
      unit_price: l.unitPrice,
    };
  });

  const cust = session.customer_details;
  const s = session as unknown as {
    shipping_details?: Addr;
    collected_information?: { shipping_details?: Addr };
  };
  const shipText =
    formatAddr(s.collected_information?.shipping_details) ??
    formatAddr(s.shipping_details) ??
    formatAddr({ name: cust?.name, address: cust?.address as unknown as Record<string, string | null> });

  await recordCustomerOrder(admin, {
    storeId,
    externalId: sessionId,
    // Stripe Checkout has no COD mode — the customer always pays up front.
    paymentType: "prepaid",
    customerName: cust?.name,
    customerEmail: cust?.email,
    customerPhone: cust?.phone,
    shipping: shipText,
    items,
  });

  return getOrderBySession(storeId, sessionId);
}

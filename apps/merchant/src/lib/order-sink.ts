import { createAdminClient } from "@ecomstrait/db/admin";
import type { OrderPaymentType } from "@ecomstrait/db";
import { propagateStockAfterSale } from "@/lib/product-propagation";
import { debitWallet, creditWallet, recordPayable, platformFee } from "@ecomstrait/db/wallet";
import { sendEmail } from "@/lib/notify";
import { recordSyntheticSignals } from "@/lib/synthetic-signals";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export type SoldItem = {
  product_id: string | null;
  supplier_id: string | null;
  name: string;
  quantity: number;
  unit_price: number | null;
};

/**
 * Tell a supplier they have COD orders held on their own wallet balance.
 * Best-effort — `suppliers` has no email column, so this resolves the
 * owner's auth email via the admin client, mirroring how a merchant's own
 * account email works today.
 */
async function notifySupplierOrdersWaiting(admin: Admin, supplierId: string): Promise<void> {
  try {
    const { data: supplier } = await admin
      .from("suppliers")
      .select("owner_user_id")
      .eq("id", supplierId)
      .maybeSingle();
    if (!supplier?.owner_user_id) return;

    const { data } = await admin.auth.admin.getUserById(supplier.owner_user_id);
    const email = data.user?.email;
    if (!email) return;

    await sendEmail({
      to: email,
      subject: "Orders waiting — add credits to receive them",
      html: `<p>You have Cash on Delivery orders waiting that your wallet balance can't currently
        cover (each COD order deducts your margin share + the platform fee up front).</p>
        <p>Add credits to your wallet to release them — they'll come through automatically once
        your balance covers what's due.</p>`,
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Record a paid customer order (from own-platform Stripe or a Shopify webhook),
 * route it to the relevant suppliers, and decrement inventory. Idempotent on
 * `externalId`. Shared by the checkout-success page and the Shopify webhook.
 *
 * `paymentType` decides which side's wallet funds this sale
 * (Docs/Credits-Settlement-Plan.md): `prepaid` (the merchant already
 * collected the money, e.g. Shopify/Stripe checkout) debits the merchant's
 * wallet for the supplier's cost + platform fee; `cod` (the supplier collects
 * cash at delivery) debits the supplier's wallet for the merchant's margin +
 * platform fee, up front. An order whose wallet can't cover its deduction is
 * still created, held (`credit_status`), and excluded from the supplier's
 * queue until a top-up releases it — it is never silently dropped.
 */
export async function recordCustomerOrder(
  admin: Admin,
  opts: {
    storeId: string;
    externalId: string;
    paymentType: OrderPaymentType;
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    shipping?: string | null;
    items: SoldItem[];
  },
): Promise<void> {
  const { data: existing } = await admin
    .from("store_orders")
    .select("id")
    .eq("stripe_session_id", opts.externalId)
    .maybeSingle();
  if (existing || opts.items.length === 0) return;

  const subtotal = opts.items.reduce((s, i) => s + (i.unit_price ?? 0) * i.quantity, 0);

  const { data: storeOrder, error: insertError } = await admin
    .from("store_orders")
    .insert({
      store_id: opts.storeId,
      customer_name: opts.customerName ?? null,
      customer_email: opts.customerEmail ?? null,
      shipping: opts.shipping ?? null,
      subtotal,
      items: opts.items,
      status: "paid",
      stripe_session_id: opts.externalId,
    })
    .select("id")
    .single();
  // The unique index on stripe_session_id is the real idempotency gate: two
  // confirmations racing past the SELECT above both reach this INSERT, and
  // exactly one wins. The loser must stop here — continuing would create a
  // second supplier order, debit the wallet again and decrement stock twice.
  if (insertError || !storeOrder) {
    if (insertError && insertError.code !== "23505") {
      console.error("[order-sink] store_orders insert failed:", insertError);
    }
    return;
  }

  // Best-effort, placeholder-for-now signals (Docs/prompts — see
  // synthetic-signals.ts) so the co-founder has customer/traffic data to
  // reason over even though no real tracking exists yet. Never blocks or
  // fails the real order above.
  {
    await recordSyntheticSignals(admin, {
      storeId: opts.storeId,
      orderId: storeOrder.id,
      subtotal,
      customerName: opts.customerName,
      customerEmail: opts.customerEmail,
    });
  }

  const { data: store } = await admin
    .from("stores")
    .select("name, user_id")
    .eq("id", opts.storeId)
    .maybeSingle();

  // Fetched once up front (not just for the suppliers' stock decrement below)
  // because cost/margin also need each item's wholesale price, snapshotted
  // onto the order now — `products.wholesale_price` can change later, and
  // the ledger must reflect what was actually charged at order time.
  const productIds = opts.items.map((i) => i.product_id).filter(Boolean) as string[];
  const { data: prods } = productIds.length
    ? await admin.from("products").select("id, stock, wholesale_price").in("id", productIds)
    : { data: [] };
  const productById = new Map((prods ?? []).map((p) => [p.id, p]));

  // One supplier order per supplier, with the customer's shipping address.
  const bySupplier = new Map<string, SoldItem[]>();
  for (const i of opts.items) {
    if (!i.supplier_id) continue;
    const arr = bySupplier.get(i.supplier_id) ?? [];
    arr.push(i);
    bySupplier.set(i.supplier_id, arr);
  }
  for (const [supplierId, supItems] of bySupplier) {
    const supplierSubtotal = supItems.reduce((s, i) => s + (i.unit_price ?? 0) * i.quantity, 0);
    const costAmount = supItems.reduce((s, i) => {
      const wholesale = i.product_id ? (productById.get(i.product_id)?.wholesale_price ?? 0) : 0;
      return s + wholesale * i.quantity;
    }, 0);
    const marginAmount = Math.max(0, supplierSubtotal - costAmount);
    const feeAmount = platformFee(supplierSubtotal);

    const { data: order } = await admin
      .from("orders")
      .insert({
        supplier_id: supplierId,
        store_id: opts.storeId,
        store_order_id: storeOrder.id,
        store_name: store?.name ?? null,
        customer_name: opts.customerName ?? null,
        customer_email: opts.customerEmail ?? null,
        customer_phone: opts.customerPhone ?? null,
        shipping: opts.shipping ?? null,
        status: "processing",
        payment_type: opts.paymentType,
        cost_amount: costAmount,
        margin_amount: marginAmount,
        platform_fee_amount: feeAmount,
      })
      .select("id")
      .single();
    if (!order) continue;

    await admin.from("order_items").insert(
      supItems.map((i) => ({
        order_id: order.id,
        product_id: i.product_id,
        product_name: i.name,
        quantity: i.quantity,
        unit_price: i.unit_price,
      })),
    );

    if (opts.paymentType === "prepaid") {
      // The merchant already holds 100% of this sale — they owe the
      // supplier's cost and the platform fee. `store` should always resolve
      // (storeId is a real FK), but if it somehow doesn't, hold the order
      // rather than default to `deducted` and expose it to the supplier
      // un-charged.
      if (!store?.user_id) {
        await admin.from("orders").update({ credit_status: "awaiting_merchant_credits" }).eq("id", order.id);
        continue;
      }
      const debit = await debitWallet(admin, costAmount + feeAmount, {
        accountType: "merchant",
        accountId: store.user_id,
        kind: "order_deduction",
        orderId: order.id,
        note: `Order ${order.id}: supplier cost + platform fee`,
        // One debit per (sale, supplier), whatever path replays this.
        externalRef: `order-debit:${opts.externalId}:${supplierId}`,
      });
      if (debit.ok) {
        await recordPayable(admin, {
          accountType: "supplier",
          accountId: supplierId,
          orderId: order.id,
          amount: costAmount,
        });
      } else {
        await admin.from("orders").update({ credit_status: "awaiting_merchant_credits" }).eq("id", order.id);
      }
    } else {
      // COD: the supplier collects the cash directly at delivery and keeps
      // it, so EcomStrait deducts the merchant's margin + the platform fee
      // from the supplier's wallet up front, as a guarantee.
      const debit = await debitWallet(admin, marginAmount + feeAmount, {
        accountType: "supplier",
        accountId: supplierId,
        kind: "order_deduction",
        orderId: order.id,
        note: `Order ${order.id}: merchant margin + platform fee`,
        externalRef: `order-debit:${opts.externalId}:${supplierId}`,
      });
      if (debit.ok) {
        if (store?.user_id) {
          await recordPayable(admin, {
            accountType: "merchant",
            accountId: store.user_id,
            orderId: order.id,
            amount: marginAmount,
          });
        } else {
          // The supplier's wallet was already debited — this order's margin
          // is money someone is now owed with no resolvable merchant to owe
          // it to. Shouldn't happen (storeId is a real FK); surfacing loudly
          // rather than swallowing it, since real money already moved.
          console.error(
            `[order-sink] order ${order.id}: debited supplier ${supplierId} for margin ${marginAmount} but store ${opts.storeId} has no resolvable owner — payable not recorded`,
          );
        }
      } else {
        await admin.from("orders").update({ credit_status: "awaiting_supplier_credits" }).eq("id", order.id);
        await notifySupplierOrdersWaiting(admin, supplierId);
      }
    }
  }

  // Two-way inventory: decrement supplier stock for matched products. Runs
  // regardless of credit_status — a held order still reserves the stock it
  // was placed against; only supplier visibility is what's gated.
  if (productIds.length) {
    for (const i of opts.items) {
      if (!i.product_id || !productById.has(i.product_id)) continue;
      // Atomic `stock = greatest(0, stock - qty)` in the database, with the
      // audit row written in the same statement — a read-modify-write here
      // let two simultaneous sales both subtract from the same stale number.
      const { error } = await admin.rpc("adjust_product_stock", {
        p_product_id: i.product_id,
        p_delta: -i.quantity,
        p_reason: "Store sale",
      });
      if (error) console.error("[order-sink] stock decrement failed:", error);
    }

    // The same product is often listed on several stores. Shopify only knows
    // about the copy that sold, so without this every other store keeps
    // advertising stock that's already gone — and oversells it.
    await propagateStockAfterSale(productIds);
  }
}

/**
 * Undo a recorded customer order after the sales channel cancelled it
 * (e.g. a Shopify `orders/cancelled` webhook). Every supplier order that
 * hasn't already shipped is cancelled, and whatever was actually debited for
 * it — read back from the ledger, never from the order row — is credited
 * back. Idempotent: reversal credits carry an `externalRef` per order.
 */
export async function reverseCustomerOrder(admin: Admin, externalId: string, reason: string): Promise<void> {
  const { data: storeOrder } = await admin
    .from("store_orders")
    .select("id, status")
    .eq("stripe_session_id", externalId)
    .maybeSingle();
  if (!storeOrder || storeOrder.status === "refunded") return;

  const { data: orders } = await admin
    .from("orders")
    .select("id, supplier_id, store_id, payment_type, credit_status, status")
    .eq("store_order_id", storeOrder.id);

  for (const o of orders ?? []) {
    if (o.status === "delivered" || o.status === "cancelled") continue;
    await admin.from("orders").update({ status: "cancelled" }).eq("id", o.id);

    if (o.credit_status !== "deducted") {
      // Held (never debited) or already reversed — nothing to give back.
      await admin.from("orders").update({ credit_status: "reversed" }).eq("id", o.id);
      continue;
    }

    if (o.payment_type === "cod") {
      // Same path a supplier's own cancellation takes; service role passes
      // its authorization check and it refunds from the ledger.
      await admin.rpc("reverse_cod_deduction", { p_order_id: o.id });
      continue;
    }

    const { data: store } = o.store_id
      ? await admin.from("stores").select("user_id").eq("id", o.store_id).maybeSingle()
      : { data: null };
    const { data: tx } = await admin
      .from("wallet_transactions")
      .select("amount")
      .eq("order_id", o.id)
      .eq("account_type", "merchant")
      .eq("kind", "order_deduction");
    const debited = -(tx ?? []).reduce((sum, t) => sum + Number(t.amount), 0);
    if (store?.user_id && debited > 0) {
      await creditWallet(admin, debited, {
        accountType: "merchant",
        accountId: store.user_id,
        kind: "reversal",
        orderId: o.id,
        note: reason,
        externalRef: `reversal:${o.id}`,
      });
    }
    await admin.from("payable_ledger").delete().eq("order_id", o.id).eq("account_type", "supplier").eq("status", "pending");
    await admin.from("orders").update({ credit_status: "reversed" }).eq("id", o.id);
  }

  await admin.from("store_orders").update({ status: "refunded" }).eq("id", storeOrder.id);
}

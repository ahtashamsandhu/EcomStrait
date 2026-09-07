import "server-only";
import type { createAdminClient } from "@ecomstrait/db/admin";
import type { TrafficSource } from "@ecomstrait/db";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

/**
 * Placeholder traffic-attribution + customer-profile data, generated on
 * every order because neither has a real data source yet (no pageview/
 * referrer tracking exists anywhere in the platform, and there's no
 * standalone customer entity — just a name/email inlined on each order).
 *
 * `is_synthetic: true` on every row this writes is the seam: a real
 * tracking pipeline built later just starts inserting `is_synthetic: false`
 * rows into the same tables, and nothing downstream (the co-founder
 * snapshot, this file) has to change. Never presented as ground truth to a
 * merchant without that caveat — see `cofounder-ai.ts`'s system prompt.
 *
 * Best-effort, always: called from `order-sink.ts` right after a real order
 * is recorded, and a failure here must never be allowed to look like the
 * order itself failed.
 */
const WEIGHTED_SOURCES: { source: TrafficSource; weight: number }[] = [
  { source: "organic_search", weight: 30 },
  { source: "social", weight: 25 },
  { source: "direct", weight: 20 },
  { source: "paid_search", weight: 15 },
  { source: "referral", weight: 7 },
  { source: "email", weight: 3 },
];

function pickTrafficSource(): TrafficSource {
  const total = WEIGHTED_SOURCES.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * total;
  for (const w of WEIGHTED_SOURCES) {
    if (r < w.weight) return w.source;
    r -= w.weight;
  }
  return WEIGHTED_SOURCES[0].source;
}

export async function recordSyntheticSignals(
  admin: Admin,
  opts: {
    storeId: string;
    orderId: string;
    subtotal: number;
    customerName?: string | null;
    customerEmail?: string | null;
  },
): Promise<void> {
  try {
    await admin.from("store_traffic_events").insert({
      store_id: opts.storeId,
      order_id: opts.orderId,
      source: pickTrafficSource(),
      is_synthetic: true,
    });

    // No email (some COD orders lack one) means no way to recognise a
    // repeat customer — it just becomes its own single-order profile below,
    // which is the honest outcome rather than guessing at deduplication.
    const email = opts.customerEmail?.trim().toLowerCase() || null;
    if (!email) return;

    const { data: existing } = await admin
      .from("customers")
      .select("id, order_count, lifetime_value")
      .eq("store_id", opts.storeId)
      .eq("email", email)
      .maybeSingle();

    if (existing) {
      await admin
        .from("customers")
        .update({
          order_count: existing.order_count + 1,
          lifetime_value: existing.lifetime_value + opts.subtotal,
          last_order_at: new Date().toISOString(),
          name: opts.customerName ?? undefined,
        })
        .eq("id", existing.id);
    } else {
      await admin.from("customers").insert({
        store_id: opts.storeId,
        email,
        name: opts.customerName ?? null,
        order_count: 1,
        lifetime_value: opts.subtotal,
        is_synthetic: true,
      });
    }
  } catch (err) {
    console.error("[synthetic-signals] failed to record (best-effort, order is unaffected):", err);
  }
}

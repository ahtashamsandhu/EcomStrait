/**
 * Shared grounding text for every data-facing prompt in the monorepo —
 * the two things the 2026-09-07 capability audit found *no* prompt was
 * being told: what day it is, and what the platform's own metrics mean.
 *
 * Every agent that writes SQL or reasons over a snapshot (Analytics Agent,
 * Business Advisor, both Co-Founders) should include both of these, so a
 * "last month" question is answered against a real calendar and "revenue"
 * means the same thing the Sales page shows. Keep METRIC_DEFINITIONS in
 * lock-step with apps/merchant/src/lib/revenue-analytics.ts — that file is
 * the source of truth for how the dashboards compute these numbers.
 */

/** "Today is 2026-09-07 (Monday), in UTC …" — one line, for a system prompt. */
export function currentDateLine(now: Date = new Date()): string {
  const iso = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return (
    `Today is ${iso} (${weekday}), in UTC — every timestamp in the database is UTC too. ` +
    `Weeks start on Monday. "This week", "last month", "yesterday" are relative to today; when you ` +
    `report a figure for any period, state the exact date range you used (e.g. "1–31 Aug 2026") so it ` +
    `can be checked. If a question gives no period and the answer genuinely depends on one, either ` +
    `pick the most natural one and say which you picked, or ask.`
  );
}

/**
 * Plain-language definitions matching the dashboards' own queries, so an
 * agent writing its own SQL lands on the same numbers the merchant sees on
 * the Sales page instead of a plausible-but-different one.
 */
export const METRIC_DEFINITIONS = [
  "Metric definitions (match the Sales page exactly — never improvise a different one):",
  "- \"Revenue\" / \"what we made\" / \"profit\" for a MERCHANT means NET REALIZED revenue: " +
    "SUM(orders.margin_amount - orders.platform_fee_amount) over `orders` rows with " +
    "credit_status = 'deducted' for that merchant's store_id(s). This is what the merchant keeps.",
  "- \"Gross sales\" / \"checkout value\" / \"how much came through\" means SUM(store_orders.subtotal) " +
    "over `store_orders` for the store — what customers paid, NOT what the merchant keeps. Never call " +
    "this figure \"revenue\" or \"profit\"; label it gross if you report it.",
  "- \"Orders\" / \"order count\" for a merchant means COUNT(*) of `store_orders` for the store (one row " +
    "per customer checkout). `orders` is the per-supplier split of each checkout — one checkout with " +
    "items from two suppliers is 1 store_order and 2 orders; don't count `orders` rows as customer orders.",
  "- \"Units\" means SUM of quantity across store_orders.items (jsonb) for the store, or " +
    "SUM(order_items.quantity) via `orders` when a per-supplier view is wanted. Exclude orders with " +
    "status = 'cancelled'.",
  "- \"Average order value\" (AOV) = gross sales / order count, both on `store_orders`.",
  "- \"On hold\" orders are `orders` with credit_status = 'awaiting_merchant_credits' — not yet sent " +
    "to the supplier because the merchant's wallet couldn't cover them; not revenue yet.",
  "- For a SUPPLIER, \"revenue\" means SUM(orders.cost_amount) over `orders` rows for that supplier_id " +
    "with credit_status = 'deducted' (realized orders only — what the supplier is actually paid).",
  "- Always aggregate in SQL (SUM/COUNT/GROUP BY); never SELECT rows to count them yourself — the " +
    "tool caps results at 100 rows, so a row-list is silently incomplete.",
].join("\n");

/**
 * Worked SQL shapes for the parts models most often get wrong against this
 * schema — jsonb line items and per-period comparisons. Include alongside
 * METRIC_DEFINITIONS in any prompt that has run_sql_query.
 */
export const SQL_EXAMPLES = [
  "Worked query shapes (adapt, don't copy blindly; always use $1 for the store id):",
  "- Product-level units from a store's checkouts (items is a jsonb array):",
  "  SELECT i->>'name' AS product, SUM((i->>'quantity')::int) AS units",
  "  FROM store_orders so, jsonb_array_elements(so.items) AS i",
  "  WHERE so.store_id = $1 AND so.status <> 'cancelled' AND so.created_at >= date_trunc('month', now()) - interval '1 month' AND so.created_at < date_trunc('month', now())",
  "  GROUP BY 1 ORDER BY units DESC LIMIT 10;",
  "- This period vs the previous one (always give a comparison when asked about performance):",
  "  SELECT CASE WHEN created_at >= now() - interval '7 days' THEN 'last_7d' ELSE 'prior_7d' END AS period,",
  "         COUNT(*) AS orders, SUM(subtotal) AS gross",
  "  FROM store_orders WHERE store_id = $1 AND created_at >= now() - interval '14 days' GROUP BY 1;",
  "- Net realized revenue for a merchant's store:",
  "  SELECT SUM(margin_amount - platform_fee_amount) AS net_revenue, COUNT(DISTINCT store_order_id) AS checkouts",
  "  FROM orders WHERE store_id = $1 AND credit_status = 'deducted';",
].join("\n");

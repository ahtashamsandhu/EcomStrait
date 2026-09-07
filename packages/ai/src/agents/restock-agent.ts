import "server-only";

import { chat } from "../gateway";

export type RestockInput = {
  productTitle: string;
  /** Already reflects the triggering sale — the platform decrements stock
   *  on order recording, before this check ever runs. Not a pre-sale value
   *  for this function to subtract `quantitySold` from itself. */
  currentStock: number;
  lowStockThreshold: number;
  /** Units sold in the order that triggered this check — context for the
   *  reasoning (e.g. "was this a demand spike?"), not an amount to net out
   *  of `currentStock`. */
  quantitySold: number;
  /** Units of this product sold in the last 7 days across non-cancelled
   *  orders (`order_items` joined to `orders`). Optional: the caller omits
   *  both velocity fields when it has no admin client or the query failed,
   *  and the prompt falls back to the limited-signal heuristic. */
  unitsSoldLast7Days?: number;
  /** Units sold in the last 30 days (same source as `unitsSoldLast7Days`).
   *  This is the number the days-of-cover rule is computed from. */
  unitsSoldLast30Days?: number;
  /** `products.wholesale_price` when set — lets the model keep the order
   *  value proportionate. Null/undefined when unknown. */
  wholesalePrice?: number | null;
};

export type RestockDecision = {
  shouldRestock: boolean;
  /** 0 when shouldRestock is false. */
  quantity: number;
  reasoning: string;
  /** Days of stock cover at the 30-day sales rate, computed in code (not by
   *  the model) when velocity was supplied. `undefined` when no velocity was
   *  available; `Infinity` when there were no sales in the last 30 days. */
  daysOfCover?: number;
};

/** Days of cover to restock up to (above the low-stock threshold). */
const TARGET_COVER_DAYS = 30;
/** Restock when cover at the 30-day rate falls below this many days. */
const MIN_COVER_DAYS = 14;

/** Round a raw unit gap up to a sensible pack size: 5 / 10 / 25 / 50. */
export function roundToPackSize(units: number): number {
  if (units <= 0) return 0;
  const pack = units <= 20 ? 5 : units <= 100 ? 10 : units <= 300 ? 25 : 50;
  return Math.ceil(units / pack) * pack;
}

/**
 * Deterministic velocity maths, shared by the prompt (so the model reasons
 * from the same figures the approver sees) and by the returned decision.
 */
export function computeVelocity(input: RestockInput): {
  unitsPerDay30: number;
  unitsPerDay7: number;
  daysOfCover: number;
  suggestedQuantity: number;
  ruleTriggered: boolean;
} | null {
  if (typeof input.unitsSoldLast30Days !== "number" || !Number.isFinite(input.unitsSoldLast30Days)) return null;
  const units30 = Math.max(0, input.unitsSoldLast30Days);
  const units7 = Math.max(0, typeof input.unitsSoldLast7Days === "number" ? input.unitsSoldLast7Days : 0);
  const unitsPerDay30 = units30 / 30;
  const unitsPerDay7 = units7 / 7;
  const daysOfCover = unitsPerDay30 > 0 ? input.currentStock / unitsPerDay30 : Infinity;
  const belowThreshold = input.currentStock <= input.lowStockThreshold;
  const ruleTriggered = daysOfCover < MIN_COVER_DAYS || belowThreshold;
  // Restock up to ~30 days of cover above the threshold, in whole packs.
  const target = input.lowStockThreshold + Math.ceil(TARGET_COVER_DAYS * unitsPerDay30);
  const gap = Math.max(0, target - input.currentStock);
  // With no recent sales at all, "30 days of cover" is 0 units — fall back
  // to topping up to just above the threshold so a triggered restock isn't 0.
  const suggestedQuantity = ruleTriggered ? roundToPackSize(gap > 0 ? gap : Math.max(1, input.lowStockThreshold - input.currentStock + 1)) : 0;
  return { unitsPerDay30, unitsPerDay7, daysOfCover, suggestedQuantity, ruleTriggered };
}

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits).replace(/\.?0+$/, "") : "n/a";
}

/**
 * Single-shot restock decision — no tools, no multi-turn conversation, so
 * this goes straight through the gateway rather than through LangGraph's
 * agent machinery. Used by the Shopify order webhook's in-process restock
 * check (apps/merchant/src/lib/restock-check.ts): fast-cheap role, since
 * this runs on every order and needs to be cheap and fast, not deep.
 *
 * Two prompt modes:
 *  - velocity supplied (`unitsSoldLast30Days` is a number): the days-of-cover
 *    rule below is applied, with the figures pre-computed in code and handed
 *    to the model, which explains and sanity-checks them (e.g. a one-off bulk
 *    order inflating the 7-day rate).
 *  - no velocity: the original limited-signal heuristic, whose reasoning must
 *    say so plainly.
 */
export async function decideRestock(input: RestockInput): Promise<RestockDecision> {
  const velocity = computeVelocity(input);

  const system = velocity
    ? [
        "You are EcomAI's inventory planner. Given a product's stock level, its recent sales velocity, and",
        "a sale that just happened, decide whether to recommend a restock and how much.",
        "Rule (already computed for you in the message below — check it, don't re-derive it loosely):",
        `- units/day = units sold in the last 30 days / 30; days-of-cover = current stock / units/day.`,
        `- Recommend a restock when days-of-cover is below ${MIN_COVER_DAYS} days OR current stock is at or below the`,
        "  low-stock threshold. Otherwise do not recommend one (shouldRestock false, quantity 0).",
        `- Size the quantity to bring stock to about ${TARGET_COVER_DAYS} days of cover above the threshold, rounded up to a`,
        "  sensible pack size (5, 10, 25 or 50 units). The suggested quantity in the message already does this;",
        "  use it unless the 7-day rate shows a clear, sustained change from the 30-day rate — then adjust by at",
        "  most one pack step and say why. A single large order (the triggering sale or the 7-day figure being",
        "  dominated by one order) is NOT a trend; do not inflate the quantity for it.",
        "- If a unit wholesale cost is given, keep the order value proportionate to the product's sales rate.",
        'Your "reasoning" MUST state the units/day and days-of-cover figures you used (e.g. "selling ~1.3/day,',
        '~9 days of cover left at that rate") and, when the sale was a spike, say so.',
        "Respond with ONLY a JSON object using these exact keys:",
        "{",
        '  "shouldRestock": boolean,',
        '  "quantity": number,   // 0 if shouldRestock is false',
        '  "reasoning": string   // one sentence naming the units/day and days-of-cover used',
        "}",
      ].join("\n")
    : [
        "You are EcomAI's inventory planner. Given a product's stock level and a",
        "sale that just happened, decide whether to recommend a restock and how much.",
        "Be conservative: only recommend a restock when stock is at or below the",
        "low-stock threshold, or the sale itself pushed it there.",
        "You are only given a single snapshot — current stock, the low-stock threshold, and the units sold",
        "in the one order that triggered this check. You have NO sales-velocity history (units/day or",
        "units/week over time) and NO supplier lead-time data. Any quantity you pick is therefore a rough",
        "heuristic gap-filler (e.g. topping back up to somewhere above the threshold), not a demand forecast —",
        'your "reasoning" text MUST say so in plain terms (e.g. "rough estimate based on current stock and',
        'this one sale, not a demand forecast — no sales history or lead time was available") so the human',
        "approver reading it doesn't mistake it for something more rigorous than it is. Never state the",
        "quantity with more confidence than that.",
        "Respond with ONLY a JSON object using these exact keys:",
        "{",
        '  "shouldRestock": boolean,',
        '  "quantity": number,   // 0 if shouldRestock is false',
        '  "reasoning": string   // one sentence, must flag this as a limited-signal heuristic estimate',
        "}",
      ].join("\n");

  const user = [
    `Product: ${input.productTitle}`,
    `Current stock (already reflects the sale below): ${input.currentStock}`,
    `Low-stock threshold: ${input.lowStockThreshold}`,
    `Units sold in the order that triggered this check: ${input.quantitySold}`,
    ...(velocity
      ? [
          `Units sold, last 30 days (non-cancelled orders): ${input.unitsSoldLast30Days}`,
          `Units sold, last 7 days (non-cancelled orders): ${input.unitsSoldLast7Days ?? 0}`,
          `Units/day (30-day rate): ${fmt(velocity.unitsPerDay30)}`,
          `Units/day (7-day rate): ${fmt(velocity.unitsPerDay7)}`,
          `Days of cover at the 30-day rate: ${Number.isFinite(velocity.daysOfCover) ? fmt(velocity.daysOfCover, 1) : "no sales in the last 30 days"}`,
          `Rule triggered (cover < ${MIN_COVER_DAYS} days or stock <= threshold): ${velocity.ruleTriggered ? "yes" : "no"}`,
          `Suggested quantity (to ~${TARGET_COVER_DAYS} days of cover above the threshold, rounded to pack size): ${velocity.suggestedQuantity}`,
          ...(typeof input.wholesalePrice === "number" && Number.isFinite(input.wholesalePrice)
            ? [`Unit wholesale cost: ${fmt(input.wholesalePrice)}`]
            : []),
        ]
      : []),
  ].join("\n");

  try {
    const { content } = await chat(
      "fast-cheap",
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // maxTokens bumped slightly from 200: the reasoning sentence now must
      // name the velocity figures it used (or, without velocity, explicitly
      // flag itself as a limited-signal heuristic, not a forecast).
      { temperature: 0, maxTokens: 300, responseFormatJson: true, timeoutMs: 8000 },
    );
    const parsed = JSON.parse(content) as Partial<RestockDecision>;
    return {
      shouldRestock: Boolean(parsed.shouldRestock),
      quantity: typeof parsed.quantity === "number" && parsed.quantity > 0 ? Math.round(parsed.quantity) : 0,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      ...(velocity ? { daysOfCover: velocity.daysOfCover } : {}),
    };
  } catch (err) {
    // Fails closed: no recommendation rather than a guessed one. A missed
    // restock alert is recoverable; a fabricated one wastes a supplier's time.
    console.error("[ai] restock decision failed:", err);
    return { shouldRestock: false, quantity: 0, reasoning: "", ...(velocity ? { daysOfCover: velocity.daysOfCover } : {}) };
  }
}

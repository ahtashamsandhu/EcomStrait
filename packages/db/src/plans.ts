import type { PlanTier } from "./types";

export type PlanEntitlement = {
  tier: PlanTier;
  label: string;
  /** Monthly price in USD (0 for free). */
  priceMonthly: number;
  /** Daily AI-token allowance. */
  tokensPerDay: number;
  /** Max number of stores. */
  storeLimit: number;
};

/**
 * Single source of truth for merchant plan limits (Doc 18 / entrepreneur
 * plan; pricing revised 2026-09-07). The Stripe Prices behind
 * STRIPE_PRICE_BASIC / _PREMIUM / _FULL must carry the same dollar amounts.
 */
export const PLAN_ENTITLEMENTS: Record<PlanTier, PlanEntitlement> = {
  free: { tier: "free", label: "Free", priceMonthly: 0, tokensPerDay: 10_000, storeLimit: 1 },
  basic: { tier: "basic", label: "Basic", priceMonthly: 9, tokensPerDay: 50_000, storeLimit: 2 },
  premium: { tier: "premium", label: "Premium", priceMonthly: 39, tokensPerDay: 1_000_000, storeLimit: 10 },
  full: { tier: "full", label: "Full", priceMonthly: 99, tokensPerDay: 5_000_000, storeLimit: 50 },
};

/** Number of early users who get all features free for a month. */
export const PROMO_USER_LIMIT = 100;

export const PLAN_ORDER: PlanTier[] = ["free", "basic", "premium", "full"];

export type SupplierPlanEntitlement = {
  tier: PlanTier;
  label: string;
  /** Monthly price in USD (0 for free). */
  priceMonthly: number;
  /** Daily AI-token allowance. */
  tokensPerDay: number;
  /** Max number of products in the catalog. `null` = unlimited. */
  productLimit: number | null;
};

/**
 * Single source of truth for supplier plan limits — same shape as
 * `PLAN_ENTITLEMENTS`, but a catalog-size cap (`productLimit`) instead of a
 * store cap, since suppliers list products, not stores.
 *
 * Pricing revised 2026-09-07: the supplier tiers carry the same dollar
 * amounts and daily token allowances as the merchant tiers by design. The
 * supplier app's own Stripe Prices (its STRIPE_PRICE_* env) must match.
 */
export const SUPPLIER_PLAN_ENTITLEMENTS: Record<PlanTier, SupplierPlanEntitlement> = {
  free: { tier: "free", label: "Free", priceMonthly: 0, tokensPerDay: 10_000, productLimit: 100 },
  basic: { tier: "basic", label: "Basic", priceMonthly: 9, tokensPerDay: 50_000, productLimit: 500 },
  premium: { tier: "premium", label: "Premium", priceMonthly: 39, tokensPerDay: 1_000_000, productLimit: 10_000 },
  full: { tier: "full", label: "Full", priceMonthly: 99, tokensPerDay: 5_000_000, productLimit: null },
};

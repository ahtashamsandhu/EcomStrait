"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Check, Sparkles } from "lucide-react";
import { PLAN_ENTITLEMENTS, PLAN_ORDER, SUPPLIER_PLAN_ENTITLEMENTS } from "@ecomstrait/db/plans";
import type { PlanTier } from "@ecomstrait/db/types";
import { Section, SectionHeading } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import { merchantSignupUrl, supplierSignupUrl } from "@/lib/site";
import { cn } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

/** Marketing-only pick, not a product signal — the merchant app's own billing
 *  page (apps/merchant/src/components/billing/billing-plans.tsx) doesn't
 *  badge any tier; this is purely which card gets the visual anchor here. */
const FEATURED_TIER = "premium";

function fmt(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${n / 1_000}K`;
  return String(n);
}

type Audience = "merchants" | "suppliers";

/** What one pricing card shows — both audiences read from the shared plan
 *  tables in packages/db, so the numbers here always match the apps. */
type CardPlan = {
  tier: PlanTier;
  label: string;
  priceMonthly: number;
  tokensPerDay: number;
  /** The tier's capacity line: stores for merchants, catalog size for suppliers. */
  capacity: string;
};

const COPY: Record<
  Audience,
  { title: string; description: string; signupUrl: string; paidCta: string }
> = {
  merchants: {
    title: "Simple plans that grow with you",
    description:
      "Start free, upgrade as your store grows. Every plan includes the full AI toolkit — more stores and AI usage as you go up.",
    signupUrl: merchantSignupUrl,
    paidCta: "Build My Business",
  },
  suppliers: {
    title: "Supplier plans that scale with your catalog",
    description:
      "Start free, upgrade as you list more. Every plan includes the full AI toolkit — a bigger catalog and more AI usage as you go up.",
    signupUrl: supplierSignupUrl,
    paidCta: "Become a Supplier",
  },
};

function plansFor(audience: Audience): CardPlan[] {
  if (audience === "suppliers") {
    return PLAN_ORDER.map((tier) => {
      const p = SUPPLIER_PLAN_ENTITLEMENTS[tier];
      return {
        tier,
        label: p.label,
        priceMonthly: p.priceMonthly,
        tokensPerDay: p.tokensPerDay,
        capacity: p.productLimit === null ? "Unlimited products" : `${fmt(p.productLimit)} products`,
      };
    });
  }
  return PLAN_ORDER.map((tier) => {
    const p = PLAN_ENTITLEMENTS[tier];
    return {
      tier,
      label: p.label,
      priceMonthly: p.priceMonthly,
      tokensPerDay: p.tokensPerDay,
      capacity: `${p.storeLimit} store${p.storeLimit === 1 ? "" : "s"}`,
    };
  });
}

export function PricingPlans({ audience = "merchants" }: { audience?: Audience }) {
  const reduce = useReducedMotion();
  const copy = COPY[audience];

  return (
    <Section tone="muted" id="pricing">
      <SectionHeading eyebrow="Pricing" title={copy.title} description={copy.description} />

      <div className="mt-12 grid gap-6 lg:grid-cols-4">
        {plansFor(audience).map((plan, i) => (
          <PlanCard
            key={plan.tier}
            plan={plan}
            signupUrl={copy.signupUrl}
            paidCta={copy.paidCta}
            featured={plan.tier === FEATURED_TIER}
            index={i}
            reduce={!!reduce}
          />
        ))}
      </div>
    </Section>
  );
}

function PlanCard({
  plan,
  signupUrl,
  paidCta,
  featured,
  index,
  reduce,
}: {
  plan: CardPlan;
  signupUrl: string;
  paidCta: string;
  featured: boolean;
  index: number;
  reduce: boolean;
}) {
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: false, margin: "-80px" }}
      transition={{ duration: 0.55, delay: index * 0.1, ease: EASE }}
      whileHover={reduce ? undefined : { y: -8 }}
      className={cn(
        "group relative flex h-full flex-col rounded-3xl border p-8 transition-shadow duration-300",
        featured
          ? "border-brand-300 bg-white shadow-2xl shadow-brand-500/10 ring-1 ring-brand-200 hover:shadow-brand-500/25"
          : "border-ink-100 bg-white hover:border-brand-200 hover:shadow-xl hover:shadow-ink-950/5",
      )}
    >
      {/* pulsing "Most popular" highlight */}
      {featured && (
        <span className="absolute -top-3 left-8 inline-flex items-center gap-1 rounded-full bg-brand-500 px-3 py-1 text-xs font-semibold text-white">
          {!reduce && (
            <motion.span
              aria-hidden
              className="absolute inset-0 rounded-full bg-brand-500"
              animate={{ scale: [1, 1.18, 1], opacity: [0.5, 0, 0.5] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
            />
          )}
          <Sparkles className="relative h-3 w-3" />
          <span className="relative">Most popular</span>
        </span>
      )}

      {/* soft glow on hover for the featured card */}
      {featured && (
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-px -z-10 rounded-3xl opacity-0 blur-md transition-opacity duration-300 group-hover:opacity-100"
          style={{ background: "radial-gradient(60% 80% at 50% 0%, rgba(16,185,129,0.25), transparent 70%)" }}
        />
      )}

      <h3 className="text-lg font-bold text-ink-950">{plan.label}</h3>

      <p className="mt-5 text-2xl font-extrabold text-ink-950 font-display">
        {plan.priceMonthly === 0 ? "Free" : `$${plan.priceMonthly}`}
        {plan.priceMonthly > 0 && <span className="text-sm font-medium text-ink-400">/mo</span>}
      </p>

      <ul className="mt-6 flex-1 space-y-3">
        <li className="flex items-center gap-2.5 text-sm text-ink-600">
          <Check className="h-4 w-4 shrink-0 text-brand-500" strokeWidth={3} />
          {fmt(plan.tokensPerDay)} AI tokens/day
        </li>
        <li className="flex items-center gap-2.5 text-sm text-ink-600">
          <Check className="h-4 w-4 shrink-0 text-brand-500" strokeWidth={3} />
          {plan.capacity}
        </li>
        <li className="flex items-center gap-2.5 text-sm text-ink-600">
          <Check className="h-4 w-4 shrink-0 text-brand-500" strokeWidth={3} />
          Full AI toolkit — builder, SEO, marketing, analytics
        </li>
      </ul>

      <div className="mt-8">
        <Button href={signupUrl} variant={featured ? "primary" : "outline"} size="md" className="w-full">
          {plan.priceMonthly === 0 ? "Start free" : paidCta}
        </Button>
      </div>
    </motion.div>
  );
}

import { createClient } from "@ecomstrait/auth/server";
import { PLAN_ENTITLEMENTS } from "@ecomstrait/db";
import type { PlanTier } from "@ecomstrait/db";
import { ensureSubscription, effectivePlan } from "@/lib/subscription";

export type Entitlements = {
  plan: PlanTier;
  tokensPerDay: number;
  storeLimit: number;
  tokensUsed: number;
  tokensRemaining: number;
  storesUsed: number;
  canCreateStore: boolean;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The caller's plan + live usage (tokens today, stores used) and derived limits. */
export async function getEntitlements(): Promise<Entitlements> {
  const sub = await ensureSubscription();
  const plan = effectivePlan(sub);
  const ent = PLAN_ENTITLEMENTS[plan];

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let tokensUsed = 0;
  let storesUsed = 0;
  if (user) {
    const { data: usage } = await supabase
      .from("usage_daily")
      .select("tokens_used")
      .eq("user_id", user.id)
      .eq("day", today())
      .maybeSingle();
    tokensUsed = usage?.tokens_used ?? 0;

    // Only launched stores count against the plan. The builder creates a draft
    // as soon as EcomAI produces a plan, so counting those would let a couple
    // of abandoned attempts lock a merchant out of the store they do want.
    //
    // Keyed on `launched_at`, not status: a launched Shopify store sits at
    // status 'draft' until it's provisioned, so excluding by status would have
    // made Shopify stores free and unlimited.
    const { count } = await supabase
      .from("stores")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .not("launched_at", "is", null);
    storesUsed = count ?? 0;
  }

  return {
    plan,
    tokensPerDay: ent.tokensPerDay,
    storeLimit: ent.storeLimit,
    tokensUsed,
    tokensRemaining: Math.max(0, ent.tokensPerDay - tokensUsed),
    storesUsed,
    canCreateStore: storesUsed < ent.storeLimit,
  };
}

/** Gate an AI action: fail if today's budget can't cover `estimated` tokens. */
export async function assertTokenBudget(
  estimated = 1,
): Promise<{ ok: true; remaining: number } | { ok: false; error: string; upgrade: true }> {
  const e = await getEntitlements();
  if (e.tokensRemaining <= 0 || e.tokensRemaining < estimated) {
    return {
      ok: false,
      error: `Daily AI limit reached (${e.tokensPerDay.toLocaleString()} tokens/day on ${PLAN_ENTITLEMENTS[e.plan].label}). Upgrade for more.`,
      // Callers surface this as an Upgrade popup instead of a plain error.
      upgrade: true,
    };
  }
  return { ok: true, remaining: e.tokensRemaining };
}

/** Record token usage against today's counter (call after an AI action). */
export async function recordTokenUsage(tokens: number): Promise<void> {
  if (tokens <= 0) return;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  // Atomic `tokens_used = tokens_used + n` in the database. The table is
  // read-only for sessions now, so a user can't zero their own counter.
  const { error } = await supabase.rpc("increment_token_usage", { p_tokens: Math.round(tokens) });
  if (error) console.error("[entitlements] usage increment failed:", error.message);
}

/** Gate store creation against the plan's store limit. */
export async function assertCanCreateStore(): Promise<
  { ok: true } | { ok: false; error: string; upgrade: true }
> {
  const e = await getEntitlements();
  if (!e.canCreateStore) {
    return {
      ok: false,
      error: `You've reached your plan's store limit (${e.storeLimit}). Upgrade to add more.`,
      upgrade: true,
    };
  }
  return { ok: true };
}

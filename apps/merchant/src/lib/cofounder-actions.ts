"use server";

import { createClient } from "@ecomstrait/auth/server";
import { createAdminClient } from "@ecomstrait/db/admin";
import { getOrComputeSnapshot, loadChatThread, appendChatTurns } from "@ecomstrait/ai";
import { getMerchantSnapshot, summarizeMerchantForAdvisor, type MerchantSnapshot } from "@/lib/cofounder-snapshot";
import type { CoFounderTurn } from "@/lib/cofounder-ai";
import { runCofounderOrchestrator } from "@/lib/agents/cofounder-orchestrator";
import { getEntitlements, assertTokenBudget, recordTokenUsage } from "@/lib/entitlements";
import { PLAN_ENTITLEMENTS } from "@ecomstrait/db";

const MAX_HISTORY_TURNS = 30;
const MAX_TURN_CHARS = 8000;

/** See the supplier app's cofounder-actions.ts: only user/assistant turns, capped, reach the prompt. */
function sanitizeHistory(raw: unknown): CoFounderTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: CoFounderTurn[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const { role, content } = t as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    turns.push({ role, content: content.slice(0, MAX_TURN_CHARS) });
  }
  return turns.slice(-MAX_HISTORY_TURNS);
}


/** Recomputing revenue/orders/customers/traffic on every message was real,
 *  repeated work — see snapshot-cache.ts. Business data moves fast enough
 *  that a forever-cache (like store_category_content) would go stale
 *  quickly, so this is a short TTL, not a "generate once" cache. */
const SNAPSHOT_TTL_MS = 15 * 60 * 1000;

/**
 * Co-Founder is now a single orchestrating agent (`runCofounderOrchestrator`,
 * `lib/agents/cofounder-orchestrator.ts`) rather than a router in front of
 * two disconnected paths — the model itself decides, via its own tools
 * (`lib/agents/cofounder-tools.ts`), whether a message needs the portfolio
 * snapshot below, a deep look at one specific store, or an actual action
 * (suggest products, build/launch a store, edit one's content or SEO). This
 * function's only remaining job is assembling what the orchestrator needs
 * to start: the cached snapshot digest, the plan/entitlements line, and the
 * token-budget guardrail — the store-name pre-classification that used to
 * live here (`detectStoreTarget`) is gone; `list_my_stores` replaces it.
 */
export async function askCoFounderAction(
  history: CoFounderTurn[],
  message: string,
): Promise<{ reply: string } | { error: string; upgrade?: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };
  const text = message.trim();
  if (!text) return { error: "Say something first." };

  const budget = await assertTokenBudget(700);
  if (!budget.ok) return { error: budget.error, upgrade: true };

  const [{ data: profile }, entitlements] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("user_id", user.id).maybeSingle(),
    getEntitlements(),
  ]);

  const admin = createAdminClient();
  const [snapshot, thread] = await Promise.all([
    getOrComputeSnapshot<MerchantSnapshot>("merchant", user.id, SNAPSHOT_TTL_MS, () =>
      getMerchantSnapshot(supabase, admin, user.id),
    ),
    // The persisted thread's rolling summary — real memory of anything
    // older than the last 30 messages this same chat already carries as
    // `history`. See packages/ai/src/memory/chat-threads.ts.
    loadChatThread({ tenantId: user.id, agent: "merchant_cofounder", threadKey: user.id }),
  ]);
  const planLine = `Plan: ${PLAN_ENTITLEMENTS[entitlements.plan].label} (${entitlements.storesUsed}/${entitlements.storeLimit} stores used, ${entitlements.tokensRemaining.toLocaleString()} AI tokens left today).`;
  const digestLines = [summarizeMerchantForAdvisor(snapshot), planLine];
  if (thread.summary) {
    digestLines.push(
      `Your own recollection of earlier in this conversation (a summary you wrote — may be ` +
        `imprecise, unlike the real numbers above; if it ever conflicts with the actual recent ` +
        `messages below, the messages win): ${thread.summary}`,
    );
  }
  const digest = digestLines.join("\n");

  const result = await runCofounderOrchestrator({
    tenantId: user.id,
    businessName: profile?.full_name || "your business",
    snapshot: digest,
    history: sanitizeHistory(history),
    message: text,
  });
  await recordTokenUsage(result.tokensUsed);
  await appendChatTurns({
    tenantId: user.id,
    agent: "merchant_cofounder",
    threadKey: user.id,
    turns: [
      { role: "user", content: text },
      { role: "assistant", content: result.reply },
    ],
  });
  return { reply: result.reply };
}

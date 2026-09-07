"use server";

import { loadChatThread, appendChatTurns } from "@ecomstrait/ai";
import { requireApprovedSupplier } from "@/lib/supplier-context";
import { getSupplierRevenueAnalytics, summarizeForAdvisor } from "@/lib/revenue-analytics";
import {
  getSupplierAnalytics,
  summarizeCatalogForAdvisor,
  getPlatformDemand,
  summarizeDemandForAdvisor,
} from "@/lib/analytics-data";
import { askCoFounder, type CoFounderTurn } from "@/lib/cofounder-ai";
import { assertTokenBudget, getEntitlements, recordTokenUsage } from "@/lib/entitlements";

const MAX_HISTORY_TURNS = 30;
const MAX_TURN_CHARS = 8000;

/**
 * The chat client replays its own transcript as `history`. Only the shape the
 * model is meant to see gets through: user/assistant roles, capped length,
 * capped count. Anything else (a forged "system" turn, a megabyte of text)
 * is dropped before it reaches the prompt.
 */
function sanitizeHistory(raw: unknown): CoFounderTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: CoFounderTurn[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const { role, content } = t as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    const turn: CoFounderTurn = { role, content: content.slice(0, MAX_TURN_CHARS) };
    const extra = t as { reasoningContent?: unknown; providerSpecificFields?: unknown };
    if (role === "assistant" && typeof extra.reasoningContent === "string") {
      turn.reasoningContent = extra.reasoningContent.slice(0, MAX_TURN_CHARS);
    }
    if (role === "assistant" && extra.providerSpecificFields && typeof extra.providerSpecificFields === "object") {
      turn.providerSpecificFields = extra.providerSpecificFields as Record<string, unknown>;
    }
    turns.push(turn);
  }
  return turns.slice(-MAX_HISTORY_TURNS);
}


export async function askCoFounderAction(
  history: CoFounderTurn[],
  message: string,
): Promise<
  | {
      reply: string;
      reasoningContent?: string;
      providerSpecificFields?: Record<string, unknown>;
      /** Today's remaining AI budget after this message was charged — the
       *  chat updates its counter from this instead of waiting for a reload. */
      tokensRemaining: number;
    }
  | { error: string; upgrade?: boolean }
> {
  const ctx = await requireApprovedSupplier();
  if ("error" in ctx) return ctx;
  if (!message.trim()) return { error: "Say something first." };

  // Estimate must track the role's real ceiling: askCoFounder calls the
  // "reasoning" role with maxTokens: 4000 (cofounder-ai.ts) — 700 was a stale
  // guess from before that role's mitigation was tuned up, and let a supplier
  // with well under a real call's worth of budget left start one anyway.
  // recordTokenUsage() below reconciles this against the actual spend
  // (gateway's real total_tokens) once the call completes.
  const budget = await assertTokenBudget(4000);
  if (!budget.ok) return { error: budget.error, upgrade: true };

  // Full row (not just business_name): getSupplierAnalytics needs it for the
  // quality-score/profile-completeness factors.
  const { data: supplier } = await ctx.supabase
    .from("suppliers")
    .select("*")
    .eq("id", ctx.supplierId)
    .maybeSingle();

  // Two independent snapshots (revenue/orders/wallet, catalog/stock/quality)
  // combined into one digest — previously only revenue was wired in, so the
  // advisor had no way to answer anything about products, stock, or the
  // quality score.
  const [revenue, catalog, demand, thread] = await Promise.all([
    getSupplierRevenueAnalytics(ctx.supabase, ctx.supplierId),
    supplier ? getSupplierAnalytics(ctx.supabase, supplier) : null,
    // Platform-wide market context (aggregates only, never another
    // supplier's rows) — null when the admin client isn't configured, in
    // which case the line is simply omitted. Never let a failure here take
    // the whole chat down: it's context, not the supplier's own numbers.
    getPlatformDemand().catch((err) => {
      console.error("[cofounder] platform demand lookup failed:", err);
      return null;
    }),
    // One thread per supplier business (not per staff account) — see
    // packages/ai/src/memory/chat-threads.ts.
    loadChatThread({ tenantId: ctx.supplierId, agent: "supplier_cofounder", threadKey: ctx.supplierId }),
  ]);
  const snapshotLines = [
    summarizeForAdvisor(revenue),
    catalog ? summarizeCatalogForAdvisor(catalog) : null,
    demand ? summarizeDemandForAdvisor(demand) : null,
  ];
  // Hedged deliberately: this is an LLM-generated summary of earlier turns,
  // not a measured number like the lines above it — flag it as your own
  // (possibly imprecise) recollection so the model doesn't repeat it back
  // with the same confidence as the real snapshot data.
  if (thread.summary)
    snapshotLines.push(
      `Your own recollection of earlier in this conversation (may be imprecise, it's a summary, not a transcript): ${thread.summary}`,
    );
  const snapshot = snapshotLines.filter(Boolean).join("\n");

  const text = message.trim();
  const result = await askCoFounder(supplier?.business_name || "your business", snapshot, sanitizeHistory(history), text);
  await recordTokenUsage(result.tokensUsed);
  const [entitlements] = await Promise.all([
    getEntitlements(),
    appendChatTurns({
      tenantId: ctx.supplierId,
      agent: "supplier_cofounder",
      threadKey: ctx.supplierId,
      turns: [
        { role: "user", content: text },
        {
          role: "assistant",
          content: result.reply,
          reasoningContent: result.reasoningContent,
          providerSpecificFields: result.providerSpecificFields,
        },
      ],
    }),
  ]);
  return {
    reply: result.reply,
    reasoningContent: result.reasoningContent,
    providerSpecificFields: result.providerSpecificFields,
    tokensRemaining: entitlements.tokensRemaining,
  };
}

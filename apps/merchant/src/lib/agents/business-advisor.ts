import { runOrchestrator, type OrchestratorInput, type OrchestratorResult } from "@ecomstrait/ai";
import { createAdminClient } from "@ecomstrait/db/admin";
import { createShopifyTools } from "./shopify-tools";
import { createShopifyWriteTools } from "./shopify-write-tools";

/**
 * "This store's id is X" alone doesn't let the agent filter a query — it
 * can see rows, but has no name/domain to match "this store" against
 * without this. Best-effort: a lookup failure degrades to no context
 * (the agent then correctly declines to guess) rather than blocking the
 * question.
 */
async function describeStore(storeId: string): Promise<string> {
  const client = createAdminClient();
  if (!client) return `store id: ${storeId}`;

  const { data: store } = await client
    .from("stores")
    .select("name, type, shopify_store_id")
    .eq("id", storeId)
    .single();

  const parts = [`store id: ${storeId}`, `store name: ${store?.name ?? "unknown"}`, `store type: ${store?.type ?? "unknown"}`];

  if (store?.shopify_store_id) {
    const { data: shopifyStore } = await client
      .from("shopify_stores")
      .select("shop_domain")
      .eq("id", store.shopify_store_id)
      .single();
    if (shopifyStore?.shop_domain) parts.push(`Shopify domain: ${shopifyStore.shop_domain}`);
  }

  return parts.join(", ");
}

export type AdvisorHistoryTurn = NonNullable<OrchestratorInput["history"]>[number];

/** How many prior runs of this thread to replay as conversation history. */
const HISTORY_RUNS = 8;

/**
 * Prior turns of this thread, rebuilt from the `ai_agent_runs` audit trail
 * (`persistAgentRun` in `@ecomstrait/ai`'s orchestrator writes one row per
 * question with `input.message` and `output.reply`). Until now that trail
 * was write-only — every question reached the advisor as a first message
 * (capability audit 2026-09-07, T5 / 6.2 / 7.6). Best-effort: a failed or
 * empty load means no history, never a failed question.
 */
async function loadThreadHistory(tenantId: string, threadId: string): Promise<AdvisorHistoryTurn[]> {
  const client = createAdminClient();
  if (!client) return [];
  try {
    const { data, error } = await client
      .from("ai_agent_runs")
      .select("input, output, created_at")
      .eq("tenant_id", tenantId)
      .eq("thread_id", threadId)
      .eq("status", "done")
      .order("created_at", { ascending: false })
      .limit(HISTORY_RUNS);
    if (error || !data) return [];

    const turns: AdvisorHistoryTurn[] = [];
    // Newest-first from the query; replay oldest-first.
    for (const run of [...data].reverse()) {
      const message = typeof run.input?.message === "string" ? run.input.message : "";
      const reply = typeof run.output?.reply === "string" ? run.output.reply : "";
      if (!message.trim() || !reply.trim()) continue;
      turns.push({ role: "user", content: message }, { role: "assistant", content: reply });
    }
    return turns;
  } catch (err) {
    console.error("[advisor] failed to load thread history:", err);
    return [];
  }
}

/**
 * Merchant-facing entry point: the generic orchestrator from `@ecomstrait/ai`,
 * with this app's Shopify tools injected and this store's identity given as
 * context. `threadId` is the storeId — one conversation thread per store
 * keeps this simple for now; a merchant with several stores gets separate
 * advisor context per store, which matches how they already think about
 * "my store" when asking a question.
 */
export async function askBusinessAdvisor(params: {
  tenantId: string;
  storeId: string;
  message: string;
  /**
   * Prior turns to hand the advisor directly, oldest first. When omitted,
   * the last few runs of this thread are loaded from `ai_agent_runs`; a
   * caller with its own transcript (e.g. the Co-Founder's
   * `ask_business_advisor` tool) can pass turns here instead.
   */
  history?: AdvisorHistoryTurn[];
}): Promise<OrchestratorResult> {
  const [storeDescription, history] = await Promise.all([
    describeStore(params.storeId),
    params.history ? Promise.resolve(params.history) : loadThreadHistory(params.tenantId, params.storeId),
  ]);
  const context = `You are discussing the following store: ${storeDescription}. Filter every query to this store.`;

  return runOrchestrator({
    tenantId: params.tenantId,
    threadId: params.storeId,
    message: params.message,
    context,
    history,
    extraTools: [
      ...createShopifyTools(params.storeId),
      ...createShopifyWriteTools({ tenantId: params.tenantId, storeId: params.storeId }),
    ],
  });
}

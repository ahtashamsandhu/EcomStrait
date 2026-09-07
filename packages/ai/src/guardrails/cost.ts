import "server-only";

import { createAdminClient } from "@ecomstrait/db/admin";
import type { ModelRole } from "../types";

const DEFAULT_DAILY_TOKEN_CAP = 200_000;

/**
 * Record token usage against the ledger. `cost_usd` stays 0 — per-model $
 * pricing isn't wired in yet, and a fabricated number is worse than an
 * honest gap. Token volume per role/model is still real signal for a future
 * swap decision even without the dollar figure (see
 * Docs/AI-Native-Migration-Plan.md's cost-ledger rationale).
 */
export async function recordUsage(params: {
  tenantId: string;
  role: ModelRole;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  if (params.inputTokens <= 0 && params.outputTokens <= 0) return;
  const client = createAdminClient();
  if (!client) return;

  const { error } = await client.from("ai_cost_ledger").insert({
    tenant_id: params.tenantId,
    role: params.role,
    model: params.model,
    input_tokens: params.inputTokens,
    output_tokens: params.outputTokens,
    cost_usd: 0,
  });
  if (error) console.error("[ai] failed to record usage:", error.message);
}

/**
 * Same discriminated-union shape as `assertTokenBudget` in
 * `apps/merchant/src/lib/entitlements.ts` — checked BEFORE spending, not
 * after, so a tenant over budget never even reaches the model.
 *
 * Fails open (returns ok: true) if the DB is unreachable — an infra hiccup
 * degrading to "no cap enforced today" is the safer failure than blocking
 * every AI feature in the platform on a ledger read.
 */
export async function assertCostBudget(
  tenantId: string,
): Promise<{ ok: true; used: number; limit: number } | { ok: false; used: number; limit: number; error: string }> {
  const limit = Number(process.env.AI_DAILY_TOKEN_CAP) || DEFAULT_DAILY_TOKEN_CAP;
  const client = createAdminClient();
  if (!client) return { ok: true, used: 0, limit };

  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const { data, error } = await client
    .from("ai_cost_ledger")
    .select("input_tokens, output_tokens")
    .eq("tenant_id", tenantId)
    .gte("created_at", since.toISOString());

  if (error) {
    console.error("[ai] failed to read cost ledger, allowing the request:", error.message);
    return { ok: true, used: 0, limit };
  }

  const used = (data ?? []).reduce((sum, r) => sum + r.input_tokens + r.output_tokens, 0);
  if (used >= limit) {
    return { ok: false, used, limit, error: `Daily AI token cap reached (${limit.toLocaleString()}/day).` };
  }
  return { ok: true, used, limit };
}

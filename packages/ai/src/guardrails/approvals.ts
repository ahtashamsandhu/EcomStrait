import "server-only";

import { createAdminClient } from "@ecomstrait/db/admin";
import type { AiApproval } from "@ecomstrait/db";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type Approval = {
  id: string;
  tenantId: string | null;
  threadId: string | null;
  agentRunId: string | null;
  action: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
};

function fromRow(row: AiApproval): Approval {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    threadId: row.thread_id,
    agentRunId: row.agent_run_id,
    action: row.action,
    payload: row.payload,
    status: row.status as ApprovalStatus,
  };
}

/**
 * Create a pending approval for a write action an agent wants to take.
 * Called from inside a write tool's handler — the tool itself never performs
 * the write; it only proposes one. See
 * `apps/merchant/src/lib/agents/shopify-write-tools.ts` for the call site
 * and `apps/merchant/src/app/api/admin/approvals/[id]/route.ts` for where an
 * approval actually gets executed.
 */
export async function requestApproval(params: {
  tenantId: string;
  threadId: string;
  action: string;
  payload: Record<string, unknown>;
}): Promise<Approval> {
  const client = createAdminClient();
  if (!client) throw new Error("[ai] Supabase admin client not configured.");

  const { data, error } = await client
    .from("ai_approvals")
    .insert({ tenant_id: params.tenantId, thread_id: params.threadId, action: params.action, payload: params.payload })
    .select("*")
    .single();

  if (error || !data) throw new Error(`[ai] failed to request approval: ${error?.message ?? "no row returned"}`);
  return fromRow(data);
}

export async function getApproval(id: string): Promise<Approval | null> {
  const client = createAdminClient();
  if (!client) return null;
  const { data } = await client.from("ai_approvals").select("*").eq("id", id).maybeSingle();
  return data ? fromRow(data) : null;
}

/**
 * Approve or reject a still-pending approval.
 *
 * The `.eq("status", "pending")` guard is load-bearing, not decorative: it's
 * what makes this safe to call twice (a double-click, a retried request) —
 * the second call matches zero rows and returns null instead of re-approving
 * (and potentially re-executing) something already resolved.
 */
export async function resolveApproval(params: {
  approvalId: string;
  approvedBy: string;
  decision: "approved" | "rejected";
}): Promise<Approval | null> {
  const client = createAdminClient();
  if (!client) throw new Error("[ai] Supabase admin client not configured.");

  const { data, error } = await client
    .from("ai_approvals")
    .update({ status: params.decision, approved_by: params.approvedBy, resolved_at: new Date().toISOString() })
    .eq("id", params.approvalId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (error) throw new Error(`[ai] failed to resolve approval: ${error.message}`);
  return data ? fromRow(data) : null;
}

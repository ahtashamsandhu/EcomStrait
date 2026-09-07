import "server-only";

import { createAdminClient } from "@ecomstrait/db/admin";
import { embedText } from "./embed";

/**
 * Sentinel tenant for shared content (e.g. the niche KB) — never a real
 * NULL. Postgres treats `NULL <> NULL`, so a nullable tenant_id would break
 * the upsert's `ON CONFLICT`: every reseed would insert a duplicate row
 * instead of updating the existing one. Kept in sync with the same literal
 * in `supabase/migrations/20260829120000_ai_native.sql`.
 */
export const GLOBAL_TENANT_ID = "00000000-0000-0000-0000-000000000000";

export type EmbeddingSource = {
  /** Omit (or pass GLOBAL_TENANT_ID) for shared content, not owned by one tenant. */
  tenantId?: string;
  sourceType: string;
  sourceId: string;
  content: string;
};

/**
 * Embed and upsert one piece of content into `ai_embeddings`.
 *
 * Upserts on (tenant_id, source_type, source_id), so re-running a seed
 * script after editing its source content (e.g. the niche KB) replaces the
 * old vector instead of accumulating duplicates.
 */
export async function upsertEmbedding(source: EmbeddingSource): Promise<void> {
  const client = createAdminClient();
  if (!client) {
    throw new Error("[ai] Supabase admin client not configured (missing SUPABASE_SERVICE_ROLE_KEY).");
  }

  const { vector, model } = await embedText(source.content);

  const { error } = await client.from("ai_embeddings").upsert(
    {
      tenant_id: source.tenantId ?? GLOBAL_TENANT_ID,
      source_type: source.sourceType,
      source_id: source.sourceId,
      content: source.content,
      embedding: vector,
      provider: model,
    },
    { onConflict: "tenant_id,source_type,source_id" },
  );

  if (error) {
    throw new Error(`[ai] failed to store embedding (${source.sourceType}/${source.sourceId}): ${error.message}`);
  }
}

/**
 * Embed and upsert several pieces of content.
 *
 * One gateway call per item rather than a single batched embed call — the
 * niche KB is ~20 short entries, so simplicity wins over the extra round
 * trips. Revisit with `embedBatch` if a future source (e.g. a large product
 * catalog) makes that cost real.
 */
export async function upsertEmbeddings(sources: EmbeddingSource[]): Promise<void> {
  for (const source of sources) await upsertEmbedding(source);
}

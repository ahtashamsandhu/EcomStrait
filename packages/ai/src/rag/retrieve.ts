import "server-only";

import { createAdminClient } from "@ecomstrait/db/admin";
import { embedText } from "./embed";

export type RetrievedChunk = {
  id: string;
  sourceType: string;
  sourceId: string;
  content: string;
  similarity: number;
};

export type RetrieveOptions = {
  /** Narrow to one source type (e.g. "niche_kb", "store_catalog"). */
  sourceType?: string;
  /**
   * Scope to one tenant's own content, blended with shared/global content.
   * Omitting this searches with NO tenant filter at all — only safe when
   * `sourceType` already scopes to shared content (e.g. "niche_kb"). Always
   * pass this when querying tenant-owned content (store catalogs, supplier
   * docs, conversations) — otherwise the search can return other tenants'
   * data.
   */
  tenantId?: string;
  matchCount?: number;
};

// `Database["public"]["Functions"]` is intentionally left empty (see
// packages/db/src/types.ts) — the same narrowing pattern already used for
// `bump_rate_limit` in apps/merchant/src/lib/rate-limit.ts.
type MatchAiEmbeddingsClient = {
  rpc: (
    fn: "match_ai_embeddings",
    args: {
      query_embedding: number[];
      match_source_type: string | null;
      match_tenant_id: string | null;
      match_count: number;
    },
  ) => Promise<{
    data: { id: string; source_type: string; source_id: string; content: string; similarity: number }[] | null;
    error: { message: string } | null;
  }>;
};

/** Embed `query` and return the closest chunks by cosine similarity. */
export async function retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
  const client = createAdminClient();
  if (!client) {
    throw new Error("[ai] Supabase admin client not configured (missing SUPABASE_SERVICE_ROLE_KEY).");
  }

  const { vector } = await embedText(query);
  const rpcClient = client as unknown as MatchAiEmbeddingsClient;

  const { data, error } = await rpcClient.rpc("match_ai_embeddings", {
    query_embedding: vector,
    match_source_type: opts.sourceType ?? null,
    match_tenant_id: opts.tenantId ?? null,
    match_count: opts.matchCount ?? 5,
  });

  if (error) throw new Error(`[ai] retrieve failed: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    content: row.content,
    similarity: row.similarity,
  }));
}

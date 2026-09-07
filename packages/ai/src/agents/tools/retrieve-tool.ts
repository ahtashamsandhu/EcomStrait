import "server-only";

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { retrieve } from "../../rag/retrieve";

/**
 * RAG tool: search the shared niche KB (illustrative niche/business planning
 * notes seeded from the marketing site's niches.ts — see
 * apps/website/src/app/api/admin/seed-niche-kb/route.ts) blended with
 * whatever has been embedded under one tenant. Today nothing in the merchant
 * or supplier apps indexes tenant content, so in practice a tenant-scoped
 * search still returns only the shared rows; the description below says so
 * rather than promising catalog/history grounding that isn't there.
 * Omitting `tenantId` searches only shared content (see `retrieve()`'s own
 * scoping warning in rag/retrieve.ts).
 */
export function createRetrieveTool(opts: { tenantId?: string; sourceType?: string } = {}) {
  return tool(
    async ({ query }: { query: string }) => {
      const matches = await retrieve(query, {
        tenantId: opts.tenantId,
        sourceType: opts.sourceType,
        matchCount: 5,
      });
      if (!matches.length) return "No relevant information found.";
      return matches
        .map((m) => `[${m.sourceType}/${m.sourceId}] (similarity ${m.similarity.toFixed(2)})\n${m.content}`)
        .join("\n\n");
    },
    {
      name: "search_knowledge_base",
      description:
        "Search the shared niche knowledge base (illustrative niche/business planning notes: example margin, " +
        "supplier-count and revenue ranges per niche, not measured platform data) plus any content that has " +
        "been indexed for this tenant. Results carry a similarity score and may be illustrative rather than " +
        "measured — treat them as rough context, not as this store's figures or a benchmark.",
      schema: z.object({ query: z.string().describe("What to search for") }),
    },
  );
}

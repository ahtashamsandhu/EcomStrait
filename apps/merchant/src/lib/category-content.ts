import "server-only";

import { createAdminClient } from "@ecomstrait/db/admin";
import { chat, isGatewayConfigured, assertCostBudget, recordUsage } from "@ecomstrait/ai";
import { categoryLabel } from "@/lib/storefront-shared";

/**
 * AI-written, cached copy for a store's category listing pages — real
 * unique content instead of a bare product grid, which is what "AI writes
 * the SEO content" turns into for a category the merchant never wrote
 * anything about themselves.
 *
 * Generated once per (store, category) and cached in `store_category_content`
 * forever after — never regenerated on our own, and never on the request
 * that's rendering the page for a customer (see `ensureCategoryDescription`'s
 * own note). Cost is attributed to the store's owner via the platform's
 * tenant-scoped cost ledger (`@ecomstrait/ai`'s guardrails), the same
 * mechanism restock automation and the business advisor already use for AI
 * work that isn't a merchant clicking a button in the moment.
 */

const SYSTEM = [
  "Write one short, natural paragraph (2-3 sentences) introducing a product",
  "category page for an online store. Warm, confident, no hype, no emojis,",
  'no headings, no markdown. Mention the category naturally — never say "category page."',
  "Never state a specific fact about the products or the store that isn't implied by the category",
  "name or the product titles given — no material, certification, warranty, guarantee, sourcing",
  "claim, or count you weren't actually told. This is cached and shown to real customers",
  "indefinitely, with no review before the first time it's shown — write generally enough to stay",
  "true rather than specifically enough to risk being wrong.",
].join(" ");

function presetDescription(storeName: string, label: string): string {
  return `Browse our ${label.toLowerCase()} collection at ${storeName} — quality picks, ready to ship.`;
}

/** The cached description for a category, or null if none has been generated yet. */
export async function getCachedCategoryDescription(storeId: string, category: string): Promise<string | null> {
  const admin = createAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("store_category_content")
    .select("description")
    .eq("store_id", storeId)
    .eq("category", category)
    .maybeSingle();
  // Supabase's client resolves with `{ error }` rather than rejecting for a
  // failed query (a missing table included) — silently treating that the
  // same as "not cached yet" would be fine for this read, but worth a log:
  // a page permanently showing no description because of a schema mismatch
  // should be visible somewhere, not indistinguishable from "not generated yet."
  if (error) {
    console.error("[category-content] could not read cached description:", error.message);
    return null;
  }
  return data?.description ?? null;
}

/**
 * Generate and cache a category's description, if it doesn't have one yet.
 *
 * Meant to run outside the request that renders the page (wrap the call in
 * `after()` at the call site) — a customer's first visit to a new category
 * must never wait on an AI call just to see the page; only later visits get
 * the description. Never throws: a failure here must never surface to
 * whoever triggered it, since by then the page has already rendered.
 */
export async function ensureCategoryDescription(params: {
  storeId: string;
  storeName: string;
  category: string;
  productTitles: string[];
}): Promise<void> {
  try {
    const admin = createAdminClient();
    if (!admin) return;

    const { data: existing, error: existingError } = await admin
      .from("store_category_content")
      .select("id")
      .eq("store_id", params.storeId)
      .eq("category", params.category)
      .maybeSingle();
    // An error here (not "no row found," which maybeSingle reports as
    // data: null with no error) means we can't actually tell whether one
    // exists — proceeding could spend an AI call on top of one that's
    // already there, so bail rather than guess.
    if (existingError) {
      console.error("[category-content] could not check for an existing description:", existingError.message);
      return;
    }
    if (existing) return;

    const label = categoryLabel(params.category);
    let description = presetDescription(params.storeName, label);

    if (isGatewayConfigured()) {
      const { data: store } = await admin.from("stores").select("user_id").eq("id", params.storeId).maybeSingle();
      const tenantId = store?.user_id;
      if (tenantId) {
        const budget = await assertCostBudget(tenantId);
        if (budget.ok) {
          try {
            const { content, tokensUsed, model } = await chat(
              "fast-cheap",
              [
                { role: "system", content: SYSTEM },
                {
                  role: "user",
                  content: `Store: ${params.storeName}\nCategory: ${label}\nSome products in it: ${
                    params.productTitles.slice(0, 10).join(", ") || "(none listed)"
                  }`,
                },
              ],
              { temperature: 0.7, maxTokens: 200, timeoutMs: 10000 },
            );
            const text = content.trim();
            if (text) description = text;
            await recordUsage({ tenantId, role: "fast-cheap", model, inputTokens: tokensUsed, outputTokens: 0 });
          } catch {
            /* preset fallback above already stands */
          }
        }
      }
    }

    // Upsert rather than insert: a second, near-simultaneous visit to the
    // same never-generated category can race this same path — the unique
    // index makes whichever write lands second a no-op update rather than a
    // constraint-violation error.
    const { error: upsertError } = await admin
      .from("store_category_content")
      .upsert({ store_id: params.storeId, category: params.category, description }, { onConflict: "store_id,category" });
    if (upsertError) console.error("[category-content] failed to save description:", upsertError.message);
  } catch (err) {
    // Only a thrown exception reaches here (e.g. `chat()`'s own network
    // failure escaping its inner try/catch) — the two Supabase calls above
    // resolve with `{ error }` rather than throwing, and are already
    // checked explicitly.
    console.error("[category-content] failed to generate description:", err);
  }
}

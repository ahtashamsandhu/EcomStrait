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
 * Generated once per (store, category) and cached in `store_category_content`.
 * Regenerated only by the cheap staleness rule in `isStale` below (a
 * category that has grown past the products its intro names, and the intro
 * is at least a month old), and never on the request that's rendering the
 * page for a customer (see `ensureCategoryDescription`'s own note). Cost is
 * attributed to the store's owner via the platform's tenant-scoped cost
 * ledger (`@ecomstrait/ai`'s guardrails), the same mechanism restock
 * automation and the business advisor already use for AI work that isn't a
 * merchant clicking a button in the moment.
 */

/** Keep in sync with `Docs/prompts/merchant-category-content.md`. */
const SYSTEM = [
  "Write the introduction shown at the top of a product category page on an online store. It is",
  "search-engine copy as much as customer copy, so: 60-110 words in 2-4 sentences, plain text — no",
  "headings, no markdown, no emojis, no bullet points. Use the category term (as given) in the first",
  'sentence and once more later, naturally — never say "category page." Name 2-3 of the listed products',
  "by their exact titles; they are real products on this store, and naming them is what makes this page",
  "different from every other store's. Give one sentence to who this range suits or when it's used.",
  "Warm, confident, no hype.",
  "Never state a specific fact about the products or the store that isn't implied by the category",
  "name or the product titles given — no material, certification, warranty, guarantee, sourcing",
  "claim, or count you weren't actually told. This is cached and shown to real customers",
  "indefinitely, with no review before the first time it's shown — write generally enough to stay",
  "true rather than specifically enough to risk being wrong.",
].join(" ");

const MAX_TITLES = 20;

/** After this long, a cached intro that no longer names the products on the page is rewritten. */
const STALE_AFTER_DAYS = 30;

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

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Does the copy name this product? Loose on purpose: the model is asked for
 * exact titles, but "Blue Canvas Tote Bag — Large" is a mention even when
 * only its first few words made it in.
 */
function mentions(description: string, title: string): boolean {
  const head = normalizeText(title).split(" ").filter(Boolean).slice(0, 3).join(" ");
  return head.length >= 3 && normalizeText(description).includes(head);
}

/**
 * The cheap staleness rule (no schema change): a cached intro is rewritten
 * only when it's at least `STALE_AFTER_DAYS` old AND names fewer than two of
 * the products currently on the page (or fewer than all of them, for a
 * category with one). A category with 3 products at first visit and 60 now
 * keeps its intro until the month is up — then, if none of what's now on the
 * page is in it, it gets a fresh one. Never more than one rewrite per month
 * per category, since the rewrite refreshes `created_at`.
 */
function isStale(existing: { description: string; created_at: string }, titles: string[]): boolean {
  const ageMs = Date.now() - new Date(existing.created_at).getTime();
  if (!(ageMs >= STALE_AFTER_DAYS * 86_400_000)) return false;
  const need = Math.min(2, titles.length);
  if (need === 0) return false;
  const named = titles.filter((t) => mentions(existing.description, t)).length;
  return named < need;
}

/**
 * Generate and cache a category's description, if it doesn't have one yet
 * (or the one it has is stale — see `isStale`).
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

    const titles = params.productTitles.map((t) => t.trim()).filter(Boolean).slice(0, MAX_TITLES);

    const { data: existing, error: existingError } = await admin
      .from("store_category_content")
      .select("id, description, created_at")
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
    if (existing && !isStale(existing, titles)) return;

    const label = categoryLabel(params.category);
    let description = presetDescription(params.storeName, label);
    let generated = false;

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
                  content: `Store: ${params.storeName}\nCategory: ${label}\nProducts in it (real titles, up to ${MAX_TITLES}): ${
                    titles.join(", ") || "(none listed)"
                  }`,
                },
              ],
              { temperature: 0.7, maxTokens: 260, timeoutMs: 10000 },
            );
            const text = content.trim();
            if (text) {
              description = text;
              generated = true;
            }
            await recordUsage({ tenantId, role: "fast-cheap", model, inputTokens: tokensUsed, outputTokens: 0 });
          } catch {
            /* preset fallback above already stands */
          }
        }
      }
    }

    // A stale intro is only replaced by a real rewrite — the preset is a
    // step down from whatever's cached, and writing it would also reset the
    // clock on a rewrite that never happened.
    if (existing && !generated) return;

    // Upsert rather than insert: a second, near-simultaneous visit to the
    // same never-generated category can race this same path — the unique
    // index makes whichever write lands second a no-op update rather than a
    // constraint-violation error.
    const { error: upsertError } = await admin
      .from("store_category_content")
      .upsert({ store_id: params.storeId, category: params.category, description }, { onConflict: "store_id,category" });
    if (upsertError) {
      console.error("[category-content] failed to save description:", upsertError.message);
      return;
    }
    // The upsert leaves `created_at` alone on the conflict path — restart the
    // staleness clock explicitly, or the next visit would rewrite it again.
    if (existing) {
      const { error: touchError } = await admin
        .from("store_category_content")
        .update({ created_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (touchError) console.error("[category-content] failed to refresh description age:", touchError.message);
    }
  } catch (err) {
    // Only a thrown exception reaches here (e.g. `chat()`'s own network
    // failure escaping its inner try/catch) — the two Supabase calls above
    // resolve with `{ error }` rather than throwing, and are already
    // checked explicitly.
    console.error("[category-content] failed to generate description:", err);
  }
}

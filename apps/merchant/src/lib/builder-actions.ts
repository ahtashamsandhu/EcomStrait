"use server";

import { redirect } from "next/navigation";
import { createClient } from "@ecomstrait/auth/server";
import { createAdminClient } from "@ecomstrait/db/admin";
import type { StoreType, StoreStatus } from "@ecomstrait/db";
import { loadChatThread, appendChatTurns, clearChatThread, type ChatThreadMessage } from "@ecomstrait/ai";
import { revalidatePath } from "next/cache";
import { assertTokenBudget, recordTokenUsage, assertCanCreateStore } from "@/lib/entitlements";
import {
  autoSelectProductsDetailed,
  getProductsByIds,
  getSelectedProducts,
  getSelectedIds,
  nicheKeywords,
  productImage,
  type CatalogProduct,
} from "@/lib/catalog";
import { suggestProductsForStore, type ProductSuggestion } from "@/lib/product-suggestions";
import { merchantUrl } from "@/lib/stripe";
import { resyncShopifyTheme } from "@/lib/shopify-actions";
import {
  generateStorePlan,
  applyMerchantRequest,
  converseBuilder,
  themeForStyle,
  type StorePlan,
  type BuilderTurn,
  type BuilderKnownContext,
  type ConverseResult,
  type PageAction,
} from "@/lib/ecomai";
import { normalizePlan } from "@/lib/store-plan";
import { purgeStoreMedia } from "@/lib/draft-sweep";
import { listStorePages, listStorePagesWithBody, type PageDetail } from "@/lib/pages-api";
import { listStoreProducts } from "@/lib/storefront-api";

export type PreviewProduct = {
  id: string;
  title: string;
  price: number | null;
  image: string | null;
  category: string | null;
};

export type BuildResult = {
  plan?: StorePlan;
  products?: PreviewProduct[];
  theme?: string;
  error?: string;
  /** True when `error` means "out of AI tokens" — show the Upgrade popup, not just the text. */
  upgrade?: boolean;
  /**
   * Set when the pre-selected inventory's category didn't match the
   * described niche and was swapped out for an auto-picked match instead —
   * shown in chat so the merchant knows their earlier selection didn't win,
   * rather than silently seeing different products than they picked.
   */
  note?: string;
};

// A direct re-export-from, not `export type { BuilderTurn, ConverseResult };`
// referencing the inline `type` import above — that shape compiles (via SWC's
// per-file, syntax-only type erasure) into a runtime `export { BuilderTurn,
// ConverseResult }`, referencing bindings that don't exist because they were
// type-only. That throws the moment this module loads, taking every action
// in this file down with it — not a caught error, a load-time ReferenceError.
export type { BuilderTurn, ConverseResult } from "@/lib/ecomai";
export type { ProductSuggestion } from "@/lib/product-suggestions";

/**
 * A merchant delegating the very first "what are you planning to sell?"
 * question ("you tell", "surprise me", "I don't know") must not turn into
 * the model silently inventing a niche and racing straight to building a
 * store around it — a real bug report: it just built the store, and the
 * merchant never got to see or choose anything. Deterministic, not left to
 * the model to self-report: relying on it to decide when to show
 * suggestions risks it just not doing so (the prompt already asks it not to
 * guess here too, as a second layer — see BUILDER_SYSTEM in ecomai.ts).
 */
const DELEGATE_PATTERN =
  /^(you\s*(tell|decide|pick|choose)|whatever you (think|want|suggest)|your call|surprise( me)?|i\s*don'?t\s*know|idk)\b/i;

/**
 * A backstop for the clearest "show me products" phrasings, checked
 * whenever the model itself didn't classify the message as `show_products`.
 * Live-tested sending the same message 3 times: the model correctly caught
 * this on its own only 2 of 3 tries — good enough as the primary mechanism
 * (the phrasing space is too open-ended for a fixed pattern to be the ONLY
 * mechanism), not good enough to be the only one. This only needs to catch
 * the unambiguous cases; anything subtler still relies on the model.
 *
 * `suggest`/`recommend` alone used to be bare words in this pattern — a real
 * bug this fixed: "suggest me a few [store] names and I'll pick one" matched
 * `\bsuggest\b` regardless of what was actually being asked for, so the
 * backstop fired and showed product cards instead of names, even after the
 * merchant explicitly clarified "I was asking about the store name." Now
 * `suggest`/`recommend` only count alongside an actual product/selling word
 * nearby — bare "show me"/"best sellers"/etc. still fire on their own, since
 * those aren't ambiguous the way a bare "suggest" is.
 */
const SHOW_PRODUCTS_PATTERN =
  /\bshow me\b|what'?s selling|what sells|best[\s-]?sellers?|top[\s-]?sellers?|top products|high[\s-]?(profit[\s-]?)?margins?/i;
const SUGGEST_OR_RECOMMEND_PATTERN = /\b(suggest|recommend)\b/i;
const PRODUCT_CONTEXT_PATTERN = /\b(product|item|sku|stock|inventory|thing|things|sell|selling)\b/i;

/**
 * One turn of the builder conversation — the AI decides what to ask next
 * (or that it's ready to build), rather than a fixed question script.
 */
/**
 * Where the opening conversation lives before a draft row exists to key it
 * on. One per merchant: the builder is a single ongoing conversation until a
 * build produces a store id, at which point `saveBuilderChatHistory` hands
 * the transcript over to that store's own thread and this one is cleared.
 */
function pendingBuilderKey(userId: string): string {
  return `pending:${userId}`;
}

type ConverseOutcome =
  | (ConverseResult & { productSuggestions?: ProductSuggestion[] })
  | { error: string; upgrade?: boolean };

/**
 * One turn of the builder conversation, persisted as it happens.
 *
 * Every exchange is written to the store's thread when `draftId` is known,
 * and to the merchant's pending thread before that — so a conversation
 * abandoned mid-way (or one whose draft save failed) is still there on the
 * next visit, the same way the Co-Founder chats are. Saving never blocks or
 * fails the turn itself.
 */
export async function converseBuilderTurn(
  history: BuilderTurn[],
  context: BuilderKnownContext,
  draftId?: string | null,
): Promise<ConverseOutcome> {
  const res = await converseBuilderTurnInner(history, context);
  if ("error" in res) return res;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const last = history[history.length - 1];
      const turns: ChatThreadMessage[] = [];
      if (last?.role === "user") turns.push({ role: "user", content: last.content });
      turns.push({ role: "assistant", content: res.reply });
      await appendChatTurns({
        tenantId: user.id,
        agent: "merchant_builder",
        threadKey: draftId ?? pendingBuilderKey(user.id),
        turns,
      });
    }
  } catch (err) {
    console.error("[builder] could not persist chat turn:", err);
  }
  return res;
}

async function converseBuilderTurnInner(
  history: BuilderTurn[],
  context: BuilderKnownContext,
): Promise<ConverseOutcome> {
  try {
    const budget = await assertTokenBudget(500);
    if (!budget.ok) return { error: budget.error, upgrade: true };

    const lastUser = [...history].reverse().find((h) => h.role === "user")?.content.trim() ?? "";
    // Used to also require this being (at most) the conversation's very
    // first user message — a real gap: BUILDER_SYSTEM's own delegation rule
    // says this can happen "at ANY point in the conversation," but this
    // deterministic backstop only covered the opening turn, leaving every
    // later one resting purely on the model's own ~2/3-reliable judgment
    // (see the comment on `SHOW_PRODUCTS_PATTERN` below). `context.inferredNiche`
    // is no longer just the pre-selection from before this chat started —
    // the caller (store-builder.tsx) now folds in whatever niche the AI
    // itself has already established mid-conversation, so this check stays
    // correctly scoped to "niche genuinely still isn't known" at any turn,
    // without misfiring on a delegate-pattern reply to some OTHER pending
    // question (audience/style) once niche is already settled.
    const nicheStillUnknown = !context.inferredNiche;
    if (nicheStillUnknown && DELEGATE_PATTERN.test(lastUser)) {
      const suggested = await suggestProductsForStore({ limit: 6 });
      if (suggested.products.length) {
        return {
          done: false,
          reply: "Here's what's doing well right now — add a few that fit, or just tell me the kind of thing you want to sell.",
          // Deliberately NOT the top seller's category: the merchant has only
          // been shown a list, they haven't picked anything. Labelling the
          // niche from it flowed into `context.inferredNiche` and the "Known
          // so far" line, and the model then carried on as if it were settled.
          niche: null,
          audience: null,
          styleKeyword: null,
          storeName: null,
          tokensUsed: 0,
          productSuggestions: suggested.products,
        };
      }
    }

    const result = await converseBuilder(history, context);
    await recordTokenUsage(result.tokensUsed);

    // Same idea as the deterministic branch above, but for a request to see
    // products that can come at ANY point in the conversation, not just the
    // opening question — "show me some products with high profit margins"
    // was previously just ignored and treated as a non-answer to whatever
    // question was pending. Primarily left to the model (via `type:
    // "show_products"` in BUILDER_SYSTEM) since the phrasing is too
    // open-ended for a fixed pattern to be the only mechanism — backed up
    // by SHOW_PRODUCTS_PATTERN for the clearest phrasings, since the model
    // alone caught this only ~2 of 3 times in testing.
    const backstopFired =
      !result.showProducts &&
      (SHOW_PRODUCTS_PATTERN.test(lastUser) ||
        (SUGGEST_OR_RECOMMEND_PATTERN.test(lastUser) && PRODUCT_CONTEXT_PATTERN.test(lastUser)));
    if (result.showProducts || backstopFired) {
      const suggested = await suggestProductsForStore({ category: result.niche ?? context.inferredNiche, limit: 6 });
      if (suggested.products.length) {
        // The requested category came back empty and this is genuinely
        // platform-wide instead — a real bug this fixed: a merchant who'd
        // just pivoted to "smartphones" asked what's available and got
        // shoes back with zero indication they weren't smartphones at all.
        // This overrides the model's own `reply` too (not just the
        // backstop's generic one) — `converseBuilder` generated that text
        // before the catalog was even queried, so it has no way to know
        // the fallback happened.
        const categoryMissed = !suggested.matchedCategory && suggested.requestedCategory;
        return {
          ...result,
          done: false,
          reply: categoryMissed
            ? `Nothing published for "${suggested.requestedCategory}" yet — here's what's actually selling across the platform right now:`
            : // The model's own `reply` is whatever it decided to say for
              // whatever it thought this was (often its next scripted
              // question) — wrong to show alongside product cards it never
              // planned for. Only override it when the backstop is what fired.
              backstopFired
              ? "Here's what's doing well right now:"
              : result.reply,
          productSuggestions: suggested.products,
        };
      }
    }

    return result;
  } catch (err) {
    // This is the one call the builder makes automatically, before a
    // merchant has done anything — an unhandled throw here doesn't show up
    // as "that action failed," it shows up as "the builder is broken."
    // Every other AI entry point in this file degrades to an error string
    // instead of throwing; this one didn't.
    console.error("[builder] converseBuilderTurn failed:", err);
    return { error: "That didn't go through — refresh and try again." };
  }
}

/**
 * Whether the merchant's already-selected inventory (from Find Products)
 * plausibly matches what they just told the conversational builder they
 * want to sell. Same keyword set `autoSelectProductsDetailed` matches a
 * niche string against the catalog with (`nicheKeywords`: stopwords out,
 * plurals stemmed), just checked against the selection instead of the whole
 * catalog: does any real word in the described niche appear in (or
 * contain) any selected product's category?
 *
 * A real bug this guards against: a merchant selects cosmetics inventory in
 * Find Products, lands in the builder, then tells the chat "a shoe store" —
 * without this check `finalizeBuilderConversation` below would still hand
 * the stale cosmetics selection to `generateStorePlan` and launch a "shoe
 * store" stocked entirely with cosmetics.
 */
function selectionMatchesNiche(products: CatalogProduct[], niche: string): boolean {
  const nicheWords = nicheKeywords(niche);
  // Nothing concrete to compare against (e.g. the "a new store" filler) —
  // don't second-guess a real selection over an unspecific niche string.
  if (!nicheWords.length) return true;
  return products.some((p) => {
    const category = (p.category ?? "").toLowerCase().trim();
    if (!category) return false;
    return nicheWords.some((w) => category.includes(w) || w.includes(category));
  });
}

/**
 * Co-founder build: generate the full plan + SEO + theme, once the
 * conversation has gathered what it needs (`converseBuilderTurn` returned
 * `done: true`). Same job `buildStore` used to do from 4 scripted answers,
 * now fed by whatever the conversation actually collected.
 *
 * `useSelected` means the merchant arrived from Find Products with products
 * already chosen — build around those instead of auto-picking for the niche,
 * as long as the selection's own category still matches what the merchant
 * described wanting to sell (see `selectionMatchesNiche`).
 */
export async function finalizeBuilderConversation(
  answers: { niche: string; audience?: string | null; styleKeyword?: string | null; storeName?: string | null },
  opts: { useSelected?: boolean } = {},
): Promise<BuildResult> {
  try {
    const budget = await assertTokenBudget(1500);
    if (!budget.ok) return { error: budget.error, upgrade: true };

    const chosen = opts.useSelected ? await getSelectedProducts() : [];
    if (!opts.useSelected && answers.niche.trim().length < 2) {
      return { error: "Tell me what you want to sell first." };
    }

    // A described niche that disagrees with the pre-selected inventory's own
    // category means that selection is stale — fall back to auto-picking
    // products that actually match the niche, same as an empty basket does.
    const nicheKnown = answers.niche.trim().length >= 2;
    const selectionMismatched = chosen.length > 0 && nicheKnown && !selectionMatchesNiche(chosen, answers.niche);

    // Fall back to auto-pick if the basket emptied between pages, or if
    // what's in it doesn't match what the merchant just said they want to sell.
    const useChosen = chosen.length > 0 && !selectionMismatched;
    const auto = useChosen ? { products: chosen, matchedNiche: true } : await autoSelectProductsDetailed(answers.niche, 8);
    const picked = auto.products;
    // Auto-pick found nothing for the niche and handed back the newest
    // published stock instead — the store still gets built (the merchant can
    // swap products), but never with a confident "Got it" over products
    // that have nothing to do with what they asked for.
    const nicheMissed = !auto.matchedNiche;

    const { plan, tokensUsed } = await generateStorePlan(
      answers,
      picked.map((p) => p.title),
      picked.map((p) => ({ title: p.title, category: p.category, price: p.retail_price })),
    );
    await recordTokenUsage(tokensUsed);

    if (answers.storeName) plan.storeName = answers.storeName.trim();

    const products: PreviewProduct[] = picked.map((p) => ({
      id: p.id,
      title: p.title,
      price: p.retail_price,
      image: productImage(p.images?.[0]),
      category: p.category,
    }));

    return {
      plan,
      products,
      theme: themeForStyle(answers.styleKeyword ?? undefined),
      note: nicheMissed
        ? `Nothing in the catalog matched "${answers.niche.trim()}" yet, so I started with recent products — swap them from Find Products anytime.`
        : selectionMismatched
          ? `Your previously selected inventory didn't match "${answers.niche.trim()}", so I picked matching products instead — swap in your own from Find Products or the product list anytime.`
          : undefined,
    };
  } catch (err) {
    console.error("[builder] finalizeBuilderConversation failed:", err);
    return { error: "Building your store didn't go through — try again in a moment." };
  }
}

/**
 * Route segments a custom page can never take — each one is a real folder
 * already, and Next.js would serve that folder either way, so a page saved
 * under one of these names would silently never be reachable at its own URL.
 */
const RESERVED_SLUGS = new Set(["products", "blog", "success"]);

function slugifyPage(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "page"
  );
}

/**
 * The database side of a `PageAction` — create, update, or delete one
 * `store_pages` row for a whole page the merchant asked EcomAI for in chat
 * ("add a Contact Us page"), as opposed to a `changes` edit to the fixed plan
 * fields. Owner-scoped through the caller's RLS-bound client, same as every
 * other builder action; a delete/update that matches nothing is reported
 * back rather than silently claimed as done.
 */
async function applyPageAction(
  supabase: SupabaseServerClient,
  storeId: string,
  action: PageAction,
): Promise<{ note: string }> {
  const slug = slugifyPage(action.slug);
  if (RESERVED_SLUGS.has(slug)) {
    return { note: `"${slug}" is already a built-in page on your store — try a different name for it.` };
  }

  if (action.action === "delete") {
    const { data: doomed, error: findErr } = await supabase
      .from("store_pages")
      .select("id, slug, title, body")
      .eq("store_id", storeId)
      .eq("slug", slug)
      .maybeSingle();
    if (findErr) return { note: `I couldn't remove that page: ${findErr.message}` };
    if (!doomed) return { note: `I couldn't find a "${slug}" page to remove.` };

    // A page delete executes on the first ask with no confirm step, so it
    // must at least be undoable: the page's own text rides along inside the
    // snapshot (`removedPages`), and `restoreStoreVersion` puts it back.
    await snapshotPageChange(supabase, storeId, `Before removing page "${slug}"`, [doomed]);

    const { error } = await supabase.from("store_pages").delete().eq("id", doomed.id);
    if (error) return { note: `I couldn't remove that page: ${error.message}` };
    return { note: `Removed the "${slug}" page — it's in Version history if you want it back.` };
  }

  const title = (action.title ?? "").trim() || slug.replace(/-/g, " ");
  const body = (action.body ?? "").trim();

  const { data: existingRow, error: findErr } = await supabase
    .from("store_pages")
    .select("id, slug, title, body")
    .eq("store_id", storeId)
    .eq("slug", slug)
    .maybeSingle();
  if (findErr) return { note: `I couldn't save that page: ${findErr.message}` };

  if (existingRow) {
    // Overwriting a page loses its old text just as surely as deleting it.
    await snapshotPageChange(supabase, storeId, `Before updating page "${slug}"`, [existingRow]);
    const { error } = await supabase.from("store_pages").update({ title, body }).eq("id", existingRow.id);
    if (error) return { note: `I couldn't update that page: ${error.message}` };
    return { note: `Updated the "${title}" page.` };
  }

  const { error } = await supabase.from("store_pages").insert({ store_id: storeId, title, slug, body });
  if (error) return { note: `I couldn't create that page: ${error.message}` };
  return { note: `Added a "${title}" page — it's live in your navigation now.` };
}

/** The compact product shape the edit chat is told about — see `applyMerchantRequest`'s `storeContext`. */
type ContextProduct = { title: string; category: string | null; price: number | null };

/**
 * What the draft is being built around, for the edit chat's context: the
 * picks saved on the draft row (`draft_products`, ids only — hydrated from
 * the catalog), or the merchant's Find Products basket when there's no
 * draft row yet. Same source `runBuild()` hands `ensureDraftStore`.
 */
async function draftProductsForContext(supabase: SupabaseServerClient, draftId?: string | null): Promise<ContextProduct[]> {
  let products: CatalogProduct[] = [];
  if (draftId) {
    const { data: draft } = await supabase.from("stores").select("draft_products").eq("id", draftId).maybeSingle();
    const ids = (draft?.draft_products ?? []).map((p) => p.id);
    if (ids.length) products = await getProductsByIds(ids);
  }
  if (!products.length) products = await getSelectedProducts();
  return products.slice(0, 40).map((p) => ({ title: p.title, category: p.category, price: p.retail_price }));
}

/**
 * Talk to EcomAI about a store that hasn't launched yet.
 *
 * Returns the assistant's own words rather than a plan alone, so the builder
 * can say what actually happened instead of always printing "Updated".
 *
 * `draftId` is the row `ensureDraftStore` created — a whole-page request
 * (create/update/delete a `store_pages` row) needs somewhere to write, so
 * before that row exists it's answered without touching the database rather
 * than silently doing nothing.
 */
export async function refineStore(
  plan: StorePlan,
  instruction: string,
  draftId?: string | null,
): Promise<{
  plan?: StorePlan;
  reply?: string;
  changed?: string[];
  error?: string;
  upgrade?: boolean;
  productSuggestions?: ProductSuggestion[];
}> {
  const budget = await assertTokenBudget(500);
  if (!budget.ok) return { error: budget.error, upgrade: true };

  // A draft's chat memory is keyed by its store id — a session that hasn't
  // built anything yet (no draftId) has nothing to key on, same as it has
  // nowhere to save the plan itself yet either.
  // Before a draft exists the chat lives in the merchant's pending thread
  // (see converseBuilderTurn), so nothing said here is lost either way.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const userId = user?.id ?? null;
  const threadKey = userId ? (draftId ?? pendingBuilderKey(userId)) : null;
  let conversationSummary: string | null = null;
  if (userId && threadKey) {
    const thread = await loadChatThread({ tenantId: userId, agent: "merchant_builder", threadKey });
    conversationSummary = thread.summary;
  }

  const existingPages = draftId ? await listStorePages(draftId) : [];
  const res = await applyMerchantRequest(plan, instruction, existingPages, conversationSummary, {
    products: await draftProductsForContext(supabase, draftId),
    // A draft has no blog yet (posts are written from the launched store's
    // own screen), and nothing in the schema records a merchant's country.
    existingPosts: [],
    country: null,
  });
  await recordTokenUsage(res.tokensUsed);

  if (userId && threadKey) {
    await appendChatTurns({
      tenantId: userId,
      agent: "merchant_builder",
      threadKey,
      turns: [
        { role: "user", content: instruction.trim() },
        { role: "assistant", content: res.reply },
      ],
    });
  }

  if (res.intent === "suggest_products") {
    const excludeIds = [...(await getSelectedIds())];
    const suggested = await suggestProductsForStore({
      category: res.productCategory || plan.collections?.[0],
      excludeIds,
    });
    // Same fallback-honesty fix as converseBuilderTurn's backstop above —
    // res.reply was generated before the catalog was queried, so it can't
    // know on its own that the requested category came back empty.
    const categoryMissed = !suggested.matchedCategory && suggested.requestedCategory;
    return {
      plan: res.plan,
      reply: categoryMissed
        ? `Nothing published for "${suggested.requestedCategory}" yet — here's what's actually selling across the platform right now:`
        : res.reply,
      productSuggestions: suggested.products,
    };
  }

  if (res.pageAction) {
    if (!draftId) {
      return { plan: res.plan, reply: "Give your store a moment to save, then ask me again and I'll add that page." };
    }
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { error: "Not authenticated." };
    const { note } = await applyPageAction(supabase, draftId, res.pageAction);
    return { plan: res.plan, reply: note };
  }

  return { plan: res.plan, reply: res.reply, changed: res.changed };
}

/** Snapshots kept per store; older ones are pruned on each write. */
const VERSION_LIMIT = 20;

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Record a store's current look before it gets overwritten, then trim the
 * history to VERSION_LIMIT. Best-effort: a failure here must never block the
 * edit the merchant actually asked for.
 */
async function snapshotStore(
  supabase: SupabaseServerClient,
  storeId: string,
  before: { content: unknown; theme: string | null; logo_url: string | null },
  label: string,
): Promise<void> {
  try {
    await supabase.from("store_theme_versions").insert({
      store_id: storeId,
      content: (before.content ?? {}) as Record<string, unknown>,
      theme: before.theme,
      logo_url: before.logo_url,
      label: label.slice(0, 200),
    });

    const { data: keep } = await supabase
      .from("store_theme_versions")
      .select("id")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(VERSION_LIMIT);

    const keepIds = (keep ?? []).map((r) => r.id);
    if (keepIds.length === VERSION_LIMIT) {
      await supabase
        .from("store_theme_versions")
        .delete()
        .eq("store_id", storeId)
        .not("id", "in", `(${keepIds.join(",")})`);
    }
  } catch {
    // History is a convenience, not a correctness requirement.
  }
}

/**
 * A `store_pages` row as carried inside a version snapshot's `content`
 * (under `removedPages`), so a page that chat deleted or overwrote can be
 * put back by `restoreStoreVersion`. `normalizePlan` builds a fresh plan
 * from known keys only, so the extra key never leaks into a rendered plan.
 */
type RemovedPage = { slug: string; title: string; body: string };
const REMOVED_PAGES_KEY = "removedPages";

/**
 * Snapshot the store as it is right now, with the page(s) about to be
 * removed/overwritten tucked into the snapshot's content — so a page action
 * shows up in Version history like any plan edit does, and restoring that
 * version brings the page back. Best-effort like `snapshotStore` itself.
 */
async function snapshotPageChange(
  supabase: SupabaseServerClient,
  storeId: string,
  label: string,
  pages: RemovedPage[],
): Promise<void> {
  const { data: store } = await supabase.from("stores").select("content, theme, logo_url").eq("id", storeId).maybeSingle();
  if (!store) return;
  const content = {
    ...((store.content ?? {}) as Record<string, unknown>),
    [REMOVED_PAGES_KEY]: pages.map((pg) => ({ slug: pg.slug, title: pg.title, body: pg.body })),
  };
  await snapshotStore(supabase, storeId, { content, theme: store.theme, logo_url: store.logo_url }, label);
}

function removedPagesIn(content: unknown): RemovedPage[] {
  const raw = content && typeof content === "object" ? (content as Record<string, unknown>)[REMOVED_PAGES_KEY] : null;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (pg): pg is RemovedPage =>
      !!pg && typeof pg === "object" && typeof (pg as RemovedPage).slug === "string" && typeof (pg as RemovedPage).title === "string",
  ).map((pg) => ({ slug: pg.slug, title: pg.title, body: typeof pg.body === "string" ? pg.body : "" }));
}

export type StoreVersion = {
  id: string;
  label: string | null;
  createdAt: string;
};

/** Recent snapshots for a store, newest first. */
export async function listStoreVersions(storeId: string): Promise<StoreVersion[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: store } = await supabase
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!store) return [];

  const { data } = await supabase
    .from("store_theme_versions")
    .select("id, label, created_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(VERSION_LIMIT);

  return (data ?? []).map((v) => ({ id: v.id, label: v.label, createdAt: v.created_at }));
}

/**
 * The store's own approved+published products, for the content editor's
 * "Best sellers" product picker. Scoped to the caller's own store — a
 * merchant can only curate a section from products actually listed on it.
 */
export async function searchStoreProductsForPicker(
  storeId: string,
  q = "",
): Promise<PreviewProduct[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: store } = await supabase
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!store) return [];

  const { products } = await listStoreProducts(storeId, { q, limit: 40 });
  return products.map((p) => ({
    id: p.id,
    title: p.title,
    price: p.price,
    image: p.image,
    category: p.category,
  }));
}

/**
 * Restore a snapshot. The current look is snapshotted first, so a restore is
 * itself undoable, and the result is re-synced to Shopify like any other edit.
 */
export async function restoreStoreVersion(
  storeId: string,
  versionId: string,
): Promise<{ plan?: StorePlan; note?: string; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data: store } = await supabase
    .from("stores")
    .select("id, type, content, theme, logo_url, shopify_store_id")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!store) return { error: "Store not found." };

  const { data: version } = await supabase
    .from("store_theme_versions")
    .select("id, content, theme, logo_url, created_at")
    .eq("id", versionId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (!version) return { error: "That version is no longer available." };

  await snapshotStore(
    supabase,
    storeId,
    { content: store.content, theme: store.theme, logo_url: store.logo_url },
    "Before restore",
  );

  // A snapshot taken before a page delete/overwrite carries that page under
  // `removedPages` (see `snapshotPageChange`) — put it back, and keep the
  // key out of `stores.content` itself, which only ever holds the plan.
  const removedPages = removedPagesIn(version.content);
  const { [REMOVED_PAGES_KEY]: _removed, ...planContent } = (version.content ?? {}) as Record<string, unknown>;
  void _removed;

  const { error: upErr } = await supabase
    .from("stores")
    .update({
      content: planContent,
      theme: version.theme,
      logo_url: version.logo_url,
    })
    .eq("id", storeId)
    .eq("user_id", user.id);
  if (upErr) return { error: upErr.message };

  let pagesNote = "";
  if (removedPages.length) {
    const { error: pageErr } = await supabase.from("store_pages").upsert(
      removedPages.map((pg) => ({ store_id: storeId, slug: pg.slug, title: pg.title, body: pg.body })),
      { onConflict: "store_id,slug" },
    );
    pagesNote = pageErr
      ? ` (I couldn't bring back the "${removedPages.map((pg) => pg.slug).join('", "')}" page: ${pageErr.message})`
      : ` The "${removedPages.map((pg) => pg.slug).join('", "')}" page is back too.`;
  }

  revalidatePath(`/store/${storeId}`);
  revalidatePath("/stores");

  const plan = normalizePlan(planContent);

  if (store.type === "shopify_liquid_theme" && store.shopify_store_id) {
    const res = await resyncShopifyTheme(storeId);
    if (res.error) return { plan, note: `Restored, but the Shopify sync failed: ${res.error}${pagesNote}` };
    return { plan, note: `Restored and pushed to your live Shopify store.${pagesNote}` };
  }
  return { plan, note: `Restored.${pagesNote}` };
}

export type EditResult = {
  plan?: StorePlan;
  synced?: "live" | "shopify" | "draft";
  note?: string;
  error?: string;
  /** True when `error` means "out of AI tokens" — show the Upgrade popup, not just the text. */
  upgrade?: boolean;
  productSuggestions?: ProductSuggestion[];
};

/**
 * Post-launch EcomAI edit: refine the persisted plan, save it, and auto-propagate
 * to the live surface — own-platform storefronts read `content` live; Shopify
 * Liquid stores get a themeFilesUpsert re-sync. Cosmetic (colors/text/logo) only.
 */
export async function editStore(storeId: string, instruction: string): Promise<EditResult> {
  if (instruction.trim().length < 2) return { error: "Tell me what to change." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data: store } = await supabase
    .from("stores")
    .select("id, type, content, theme, logo_url, shopify_store_id")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!store) return { error: "Store not found." };

  const budget = await assertTokenBudget(500);
  if (!budget.ok) return { error: budget.error, upgrade: true };

  const current = normalizePlan(store.content);
  const existingPages = await listStorePages(storeId);
  const thread = await loadChatThread({ tenantId: user.id, agent: "merchant_builder", threadKey: storeId });
  // What the store actually sells and has already published, so the model
  // edits copy about real products and doesn't propose a blog post that
  // already exists. Drafts count as existing posts too — a duplicate draft
  // is still a duplicate.
  const [{ products: listed }, { data: posts }] = await Promise.all([
    listStoreProducts(storeId, { limit: 40 }),
    supabase.from("store_posts").select("title, slug").eq("store_id", storeId).order("created_at", { ascending: false }).limit(30),
  ]);
  const ai = await applyMerchantRequest(current, instruction, existingPages, thread.summary, {
    products: listed.map((p) => ({ title: p.title, category: p.category, price: p.price })),
    existingPosts: (posts ?? []).map((p) => ({ title: p.title, slug: p.slug })),
    // Nothing in the schema records a merchant's or store's country yet.
    country: null,
  });
  const plan = ai.plan;
  await recordTokenUsage(ai.tokensUsed);
  await appendChatTurns({
    tenantId: user.id,
    agent: "merchant_builder",
    threadKey: storeId,
    turns: [
      { role: "user", content: instruction.trim() },
      { role: "assistant", content: ai.reply },
    ],
  });

  // Same reasoning as pageAction below — a whole-page/product-suggestion
  // request never touches `content` (`ai.changed` stays empty), so this has
  // to be checked before the "nothing changed" branch, or it gets misrouted
  // into the question path.
  if (ai.intent === "suggest_products") {
    const { data: listed } = await supabase.from("store_products").select("product_id").eq("store_id", storeId);
    const excludeIds = (listed ?? []).map((l) => l.product_id);
    const suggested = await suggestProductsForStore({
      category: ai.productCategory || current.collections?.[0],
      excludeIds,
    });
    // Same fallback-honesty fix as converseBuilderTurn/refineStore above.
    const categoryMissed = !suggested.matchedCategory && suggested.requestedCategory;
    return {
      plan: current,
      synced: "live",
      note: categoryMissed
        ? `Nothing published for "${suggested.requestedCategory}" yet — here's what's actually selling across the platform right now:`
        : ai.reply,
      productSuggestions: suggested.products,
    };
  }

  // A whole-page request never touches `content` (`ai.changed` stays empty),
  // so it has to be checked before that "nothing changed" branch below, or
  // "add a Contact Us page" would be misrouted into the advisor/question path.
  if (ai.pageAction) {
    const { note } = await applyPageAction(supabase, storeId, ai.pageAction);
    revalidatePath(`/store/${storeId}`);

    if (store.type === "shopify_liquid_theme") {
      // Custom pages aren't pushed to a Shopify shop yet — only the
      // own-platform storefront reads `store_pages` today.
      return { plan: current, synced: "draft", note: `${note} Add it in your Shopify admin's Pages section too, to show it on your live Shopify store.` };
    }
    return { plan: current, synced: store.type === "own_platform" ? "live" : "draft", note };
  }

  // A question or a request we can't act on must not write to the store, nor
  // burn a version-history slot describing an edit that never happened.
  if (!ai.changed.length) {
    // The builder chat no longer escalates a genuine question to the
    // business-advisor agent at all — that capability moved to the
    // Co-Founder chat (see cofounder-actions.ts's store-specific routing),
    // which can ask about any store by name from one place. The builder
    // stays scoped to building/editing this one store, full stop: a
    // question here just gets the inline reply, same as "unsupported".
    // (This is also what fixed a real bug: the advisor had no idea this
    // chat could edit store content, and confidently told a merchant with
    // no Shopify store at all to go find the hero section in "Shopify
    // Admin" — removing the escalation removes that whole failure mode.)
    return { plan: current, synced: "live", note: ai.reply };
  }

  // Capture the pre-edit look so this change can be undone.
  await snapshotStore(
    supabase,
    storeId,
    { content: store.content, theme: store.theme, logo_url: store.logo_url },
    instruction.trim(),
  );

  const { error: upErr } = await supabase
    .from("stores")
    .update({
      content: plan as unknown as Record<string, unknown>,
      // `storeName` lives in two places that must never drift apart: inside
      // `content` (what the plan itself renders) and this top-level column
      // (what /stores, list_my_stores, and everywhere else that isn't
      // rendering the plan actually reads). A real bug this fixed: asking
      // this chat to rename a store got a confident "Done — renamed to X"
      // reply, `content.storeName` really did change, but this column never
      // did — so the Stores list, the dashboard, and this store's own
      // browser-tab title kept showing the old name, and it looked like
      // nothing had happened at all.
      ...(ai.changed.includes("storeName") ? { name: plan.storeName.trim() || "My Store" } : {}),
    })
    .eq("id", storeId);
  if (upErr) return { error: upErr.message };

  revalidatePath(`/store/${storeId}`);
  revalidatePath("/stores");

  // Auto-propagate to wherever the store is live.
  if (store.type === "own_platform") {
    return { plan, synced: "live", note: `${ai.reply} Your live storefront is updated.` };
  }
  if (store.type === "shopify_liquid_theme" && store.shopify_store_id) {
    const res = await resyncShopifyTheme(storeId);
    if (res.error) return { plan, synced: "draft", note: `${ai.reply} But the Shopify sync failed: ${res.error}` };
    return { plan, synced: "shopify", note: `${ai.reply} Pushed to your live Shopify store.` };
  }
  return { plan, synced: "draft", note: `${ai.reply} Provision the store to publish it.` };
}

/**
 * Persist the launched-store settings that aren't part of the AI plan (name,
 * theme, logo). Cosmetic values still flow through `editStore`; this is the
 * action bar's "Save changes".
 */
export async function updateStore(
  storeId: string,
  input: {
    name: string;
    theme: string;
    logoUrl: string | null;
    /** The edited content plan. Omit to leave `stores.content` untouched. */
    content?: StorePlan;
  },
): Promise<{ error?: string; note?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data: store } = await supabase
    .from("stores")
    .select("id, type, theme, content, logo_url, shopify_store_id")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!store) return { error: "Store not found." };

  const themeChanged = Boolean(input.theme) && input.theme !== store.theme;
  const logoChanged = (input.logoUrl ?? null) !== store.logo_url;
  const contentChanged =
    input.content !== undefined &&
    JSON.stringify(input.content) !== JSON.stringify(store.content ?? {});

  // Only snapshot when the look actually changes — renaming a store shouldn't
  // fill the history with visually identical entries.
  if (themeChanged || logoChanged || contentChanged) {
    await snapshotStore(
      supabase,
      storeId,
      { content: store.content, theme: store.theme, logo_url: store.logo_url },
      themeChanged ? `Theme → ${input.theme}` : contentChanged ? "Content edited" : "Logo changed",
    );
  }

  const { error } = await supabase
    .from("stores")
    .update({
      name: input.name.trim() || "My Store",
      theme: input.theme || null,
      logo_url: input.logoUrl,
      ...(contentChanged ? { content: input.content as unknown as Record<string, unknown> } : {}),
    })
    .eq("id", storeId)
    .eq("user_id", user.id);
  if (error) return { error: error.message };

  revalidatePath(`/store/${storeId}`);
  revalidatePath("/stores");

  // Push the logo/colour settings onto an already-published Shopify theme.
  if (store.type === "shopify_liquid_theme" && store.shopify_store_id) {
    const res = await resyncShopifyTheme(storeId);
    if (res.error) return { note: `Saved, but the Shopify sync failed: ${res.error}` };
    // A different theme id means a different Liquid package, which only gets
    // installed by a fresh provision — re-syncing settings can't swap it.
    return {
      note: themeChanged
        ? "Saved and re-synced. The new theme design applies the next time this store is provisioned."
        : "Saved and pushed to your live Shopify store.",
    };
  }

  return { note: "Saved." };
}

/**
 * The store row the builder edits before Launch.
 *
 * It exists because the content editor and the media library both address a
 * store by id — an upload has to belong to something. Creating the row up
 * front is what lets a merchant assemble their store properly instead of
 * launching first and fixing the images afterwards.
 *
 * Reuses the merchant's newest draft rather than inserting per attempt. Someone
 * who rebuilds three times should end up with one row, not three, and keeping
 * the same id means the media they already uploaded is still there.
 *
 * `draftId` pins a specific draft — the builder passes the one it's resuming,
 * so a second tab can't quietly redirect the work into a different row.
 */
/**
 * Save the opening "asking" conversation's chat history for the first time,
 * the moment a store id actually exists to key it on — `runBuild()` calls
 * this once, right after `ensureDraftStore()` succeeds, with everything
 * accumulated so far. Before that point there's nothing to key a thread on
 * (matches today's behavior: a session abandoned before any draft has
 * nothing worth resuming either), so nothing is lost by not saving turn by
 * turn during that stage — just bulk-saved the one time it first can be.
 */
export async function saveBuilderChatHistory(
  storeId: string,
  turns: { role: "user" | "assistant"; content: string }[],
): Promise<void> {
  if (!turns.length) return;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  await appendChatTurns({ tenantId: user.id, agent: "merchant_builder", threadKey: storeId, turns });
  // The conversation now lives with the store; the pending copy has done its job.
  await clearChatThread({ tenantId: user.id, agent: "merchant_builder", threadKey: pendingBuilderKey(user.id) });
}

/** Forget the opening conversation that hasn't produced a draft yet ("Start over"). */
export async function clearPendingBuilderChat(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  await clearChatThread({ tenantId: user.id, agent: "merchant_builder", threadKey: pendingBuilderKey(user.id) });
}

/**
 * Refetch a store's custom pages for the live preview — called after a
 * "ready"-stage chat turn (editStore/refineStore), since a page is the one
 * thing the preview shows that can actually be created *through this same
 * chat*, mid-session (blog posts are written from a separate screen, so an
 * initial load covers those; see store-builder.tsx). `listStorePages()`
 * itself has no ownership check of its own (by design — it's a public read
 * for the live storefront's nav, see pages-api.ts), so this wrapper adds
 * one, matching every other function in this file that takes a storeId
 * from the client.
 */
export async function listBuilderPreviewPages(storeId: string): Promise<PageDetail[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data: store } = await supabase.from("stores").select("id").eq("id", storeId).eq("user_id", user.id).maybeSingle();
  if (!store) return [];
  return listStorePagesWithBody(storeId);
}

export async function ensureDraftStore(input: {
  draftId?: string | null;
  name: string;
  theme: string;
  logoUrl?: string | null;
  plan: StorePlan;
  products: { id: string; price: number | null }[];
}): Promise<{ storeId?: string; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const fields = {
    name: input.name.trim() || "My Store",
    theme: input.theme || null,
    logo_url: input.logoUrl ?? null,
    content: input.plan as unknown as Record<string, unknown>,
    draft_products: input.products,
  };

  // Guard on `launched_at` as well as ownership: once a draft has been launched
  // its row is a real store, and a stale builder tab must not write over it.
  // Status alone won't do — a launched Shopify store is 'draft' too.
  const reuse = async (id: string) =>
    supabase
      .from("stores")
      .update(fields)
      .eq("id", id)
      .eq("user_id", user.id)
      .is("launched_at", null)
      .select("id")
      .maybeSingle();

  if (input.draftId) {
    const { data } = await reuse(input.draftId);
    if (data) return { storeId: data.id };
    // The pinned draft was launched or swept — fall through and make a new one.
  }

  const { data: newest } = await supabase
    .from("stores")
    .select("id")
    .eq("user_id", user.id)
    .eq("status", "draft")
    .is("launched_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (newest) {
    const { data } = await reuse(newest.id);
    if (data) return { storeId: data.id };
  }

  const { data: created, error } = await supabase
    .from("stores")
    .insert({
      user_id: user.id,
      // The selling path is chosen in the action bar, which the merchant may
      // not have touched yet. `type` is NOT NULL, so a draft holds the default
      // and Launch writes whatever they actually picked.
      type: "own_platform",
      status: "draft",
      ...fields,
    })
    .select("id")
    .single();
  if (error || !created) return { error: error?.message ?? "Could not save your draft." };

  return { storeId: created.id };
}

/**
 * Persist in-progress builder edits onto the draft.
 *
 * Doubles as the TTL heartbeat — `stores_touch_updated_at` moves `updated_at`
 * on every write, so a draft someone is actively working on can't be swept out
 * from under them.
 */
export async function saveDraft(
  storeId: string,
  input: {
    name: string;
    theme: string;
    logoUrl: string | null;
    plan: StorePlan;
    products: { id: string; price: number | null }[];
  },
): Promise<{ ok?: true; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data, error } = await supabase
    .from("stores")
    .update({
      name: input.name.trim() || "My Store",
      theme: input.theme || null,
      logo_url: input.logoUrl,
      content: input.plan as unknown as Record<string, unknown>,
      draft_products: input.products,
    })
    .eq("id", storeId)
    .eq("user_id", user.id)
    .is("launched_at", null)
    .select("id")
    .maybeSingle();
  if (error) return { error: error.message };
  // No row means it's no longer a draft — launched in another tab, or swept.
  if (!data) return { error: "This draft is no longer available." };

  return { ok: true };
}

/** Throw away a draft and everything attached to it. */
export async function discardDraft(storeId: string): Promise<{ ok?: true; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  // Ownership is checked here so the media purge can't be aimed at someone
  // else's store by id; the delete below re-checks it against RLS anyway.
  const { data: store } = await supabase
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .is("launched_at", null)
    .maybeSingle();
  if (!store) return { error: "Draft not found." };

  const admin = createAdminClient();
  if (admin) await purgeStoreMedia(admin, [storeId]);

  const { error } = await supabase
    .from("stores")
    .delete()
    .eq("id", storeId)
    .eq("user_id", user.id)
    .is("launched_at", null);
  if (error) return { error: error.message };
  // The chat about a draft that no longer exists shouldn't greet the next one.
  await Promise.all([
    clearChatThread({ tenantId: user.id, agent: "merchant_builder", threadKey: storeId }),
    clearChatThread({ tenantId: user.id, agent: "merchant_builder", threadKey: pendingBuilderKey(user.id) }),
  ]);

  revalidatePath("/stores");
  return { ok: true };
}

/**
 * Launch the store: persist plan + products; own-platform stores go live.
 *
 * `draftId` promotes the row the builder has been editing rather than inserting
 * a new one, so the media uploaded during the build stays attached to the store
 * that ends up live.
 */
export type LaunchStoreInput = {
  draftId?: string | null;
  name: string;
  type: StoreType;
  theme: string;
  logoUrl?: string | null;
  plan: StorePlan;
  products: { id: string; price: number | null }[];
};

export type LaunchStoreResult = { storeId: string; liveUrl?: string } | { error: string; upgrade?: boolean };

/**
 * The actual DB-mutation work behind launching a store — pulled out of
 * `createStore()` (below) so it can be reused by anything that isn't a
 * form submission and can't tolerate `createStore`'s `redirect()` call,
 * which throws and has no return value on success. The Co-Founder
 * orchestrator's `launch_store` tool is the reason this exists — see
 * `apps/merchant/src/lib/agents/cofounder-tools.ts`.
 */
export async function launchStoreCore(input: LaunchStoreInput): Promise<LaunchStoreResult> {
  const gate = await assertCanCreateStore();
  if (!gate.ok) return { error: gate.error, upgrade: true };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const isOwn = input.type === "own_platform";
  const fields = {
    name: input.name.trim() || "My Store",
    type: input.type,
    theme: input.theme || null,
    logo_url: input.logoUrl ?? null,
    content: input.plan as unknown as Record<string, unknown>,
    // A Shopify store isn't ready for anything until it's been provisioned —
    // claiming a shop, pushing products and uploading the theme. Marking it
    // ready_for_review here made launch look like it had done that work.
    status: (isOwn ? "live" : "draft") as StoreStatus,
    // The picks become real listings below, so the holding field is cleared.
    draft_products: [],
    // What separates a launched store from a builder draft. It also stops the
    // expiry sweep touching a Shopify store, which stays at status 'draft'
    // until it's been provisioned.
    launched_at: new Date().toISOString(),
  };

  let store: { id: string } | null = null;

  if (input.draftId) {
    // `.is("launched_at", null)` makes the promotion idempotent: a double-click
    // that gets past the button's disabled state finds nothing to update the
    // second time rather than launching the same store twice.
    const { data, error } = await supabase
      .from("stores")
      .update(fields)
      .eq("id", input.draftId)
      .eq("user_id", user.id)
      .is("launched_at", null)
      .select("id")
      .maybeSingle();
    if (error) return { error: error.message };
    if (!data) return { error: "This store has already been launched." };
    store = data;
  }

  if (!store) {
    const { data, error } = await supabase
      .from("stores")
      .insert({ user_id: user.id, ...fields })
      .select("id")
      .single();
    if (error || !data) return { error: error?.message ?? "Could not launch store." };
    store = data;
  }

  if (input.products.length) {
    // Listings start pending and carry their supplier, so each one lands in that
    // supplier's approval queue rather than going live unreviewed.
    const admin = createAdminClient();
    const supplierByProduct = new Map<string, string>();
    if (admin) {
      const { data: owned } = await admin
        .from("products")
        .select("id, supplier_id")
        .in(
          "id",
          input.products.map((p) => p.id),
        );
      (owned ?? []).forEach((p) => supplierByProduct.set(p.id, p.supplier_id));
    }

    await supabase.from("store_products").insert(
      input.products.map((p) => ({
        store_id: store.id,
        product_id: p.id,
        price: p.price,
        supplier_id: supplierByProduct.get(p.id) ?? null,
        status: "pending" as const,
      })),
    );

    // These products just became real listings (awaiting supplier approval)
    // on a real store — they're no longer "queued for a store not built
    // yet". A real bug this fixed: the pre-launch `selected_products` basket
    // was never cleared on launch, so Selected Inventory kept showing the
    // same products as still "queued" indefinitely, right alongside their
    // new, real "awaiting supplier" listing on the store just created.
    await supabase
      .from("selected_products")
      .delete()
      .eq("user_id", user.id)
      .in(
        "product_id",
        input.products.map((p) => p.id),
      );
  }

  let liveUrl: string | undefined;
  if (isOwn) {
    liveUrl = `${merchantUrl()}/store/${store.id}`;
    await supabase.from("stores").update({ live_url: liveUrl }).eq("id", store.id);
  }

  return { storeId: store.id, liveUrl };
}

export async function createStore(input: LaunchStoreInput): Promise<{ error?: string; upgrade?: boolean } | never> {
  const result = await launchStoreCore(input);
  if ("error" in result) return result;
  redirect("/stores");
}

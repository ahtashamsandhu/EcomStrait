import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createClient } from "@ecomstrait/auth/server";
import type { StoreType } from "@ecomstrait/db";
import { autoSelectProducts, getProductsByIds, type CatalogProduct } from "@/lib/catalog";
import { suggestProductsForStore } from "@/lib/product-suggestions";
import { generateStorePlan, themeForStyle, type PlanAnswers, type StorePlan } from "@/lib/ecomai";
import { ensureDraftStore, launchStoreCore, editStore } from "@/lib/builder-actions";
import { generatePostDraft } from "@/lib/blog-actions";
import { assertTokenBudget, recordTokenUsage } from "@/lib/entitlements";
import { askBusinessAdvisor } from "./business-advisor";

/**
 * Did the products this store is being built around actually match the
 * niche? `autoSelectProducts` silently falls back to the newest published
 * products when nothing matches the niche term (catalog.ts), and a
 * `productIds` list from a prior `suggest_products` call may itself have
 * been a platform-wide fallback — so the tool result says which it was,
 * rather than presenting a random assortment as "a store around X"
 * (2026-09-07 capability audit, §9.5). Same shape as builder-actions.ts's
 * `selectionMatchesNiche`, extended to titles as well as categories.
 */
function productsMatchNiche(products: CatalogProduct[], niche: string): boolean {
  const nicheWords = niche
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  if (!nicheWords.length) return true;
  return products.some((p) => {
    const haystack = `${p.category ?? ""} ${p.title}`.toLowerCase();
    return nicheWords.some((w) => haystack.includes(w));
  });
}

/**
 * The tools that make Co-Founder an orchestrator rather than a chat that
 * only reasons over a static snapshot — each one IS a specialist the user
 * asked for: `suggest_products` is the Product Consultant, `build_store` /
 * `launch_store` / `edit_store_content` are the Website Builder (SEO is a
 * flavor of `edit_store_content`, same as it already is in the builder
 * chat's own intent classification — see `ecomai.ts`'s `MERCHANT_SYSTEM`),
 * and `ask_business_advisor` delegates to the existing tool-calling
 * Business Advisor agent for a deep, grounded read on one specific store.
 *
 * Every tool closes over `tenantId` — never accepts it as a model-supplied
 * argument — and otherwise reuses the exact same session-authenticated,
 * ownership-checked functions the human-driven UI already calls (no new
 * auth logic invented here). See `cofounder-orchestrator.ts` for how these
 * get assembled into the actual agent.
 */
export function createCofounderTools(opts: { tenantId: string }) {
  const listMyStores = tool(
    async () => {
      const supabase = await createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return "Not authenticated.";
      const { data } = await supabase
        .from("stores")
        .select("id, name, type, status, theme, launched_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (!data?.length) return "This merchant has no stores yet — not even an unlaunched draft.";
      return JSON.stringify(
        data.map((s) => ({
          id: s.id,
          name: s.name ?? "Untitled",
          type: s.type,
          status: s.status,
          theme: s.theme,
          launched: Boolean(s.launched_at),
        })),
      );
    },
    {
      name: "list_my_stores",
      description:
        "List this merchant's own stores (id, name, type, status, whether it's launched or still a draft). Call this first whenever a request mentions 'my store' or names one, to resolve which storeId the other tools need.",
      schema: z.object({}),
    },
  );

  const suggestProducts = tool(
    async ({ category, storeId, limit }: { category?: string; storeId?: string; limit?: number }) => {
      let excludeIds: string[] = [];
      if (storeId) {
        const supabase = await createClient();
        const { data } = await supabase.from("store_products").select("product_id").eq("store_id", storeId);
        excludeIds = (data ?? []).map((r) => r.product_id);
      }
      const suggested = await suggestProductsForStore({
        category: category ?? null,
        excludeIds,
        limit: limit ?? 6,
      });
      if (!suggested.products.length) return "No matching products found on the platform right now.";
      return JSON.stringify({
        // False means the requested category matched nothing and these are
        // genuine platform-wide results instead — say so plainly if you
        // relay these, never present them as if they were the category
        // asked for.
        matchedCategory: suggested.matchedCategory,
        // "category" = the catalog's own category string matched; "title" =
        // only product titles matched the phrase (still a real match, say
        // "matched by product title" if it matters); null = fallback.
        matchedBy: suggested.matchedBy,
        requestedCategory: suggested.requestedCategory,
        products: suggested.products.map((p) => ({
          id: p.id,
          title: p.title,
          category: p.category,
          retailPrice: p.retail_price,
          unitsSold: p.unitsSold,
          marginPct: p.marginPct,
          reason: p.reason,
        })),
      });
    },
    {
      name: "suggest_products",
      description:
        "Suggest real, ranked products from the platform catalog for the merchant to sell — ranked by actual units sold and margin, never a guess. Use when asked what to sell, for product ideas, or before building a store around a niche. Pass storeId to exclude products already listed there. The result's matchedCategory tells you whether the requested category actually had matches — if false, these are platform-wide fallback picks, not the category asked for, and you must say so plainly rather than presenting them as a match. matchedBy says whether the match was on the catalog category or only on product titles. Products are in stock and ranked by units sold in the last 90 days plus margin.",
      schema: z.object({
        category: z.string().optional().describe("A niche/category hint, e.g. 'shoes' — omit for platform-wide top sellers"),
        storeId: z.string().optional().describe("Exclude products already listed on this store"),
        limit: z.number().optional().describe("Max results, default 6"),
      }),
    },
  );

  const buildStore = tool(
    async ({
      niche,
      audience,
      styleKeyword,
      storeName,
      productIds,
    }: {
      niche: string;
      audience?: string;
      styleKeyword?: string;
      storeName?: string;
      productIds?: string[];
    }) => {
      const budget = await assertTokenBudget(1500);
      if (!budget.ok) return budget.error;

      const products = productIds?.length ? await getProductsByIds(productIds) : await autoSelectProducts(niche, 8);
      if (!products.length) {
        return "Couldn't find any published products to build this store around — try suggest_products first, or a different niche.";
      }

      const answers: PlanAnswers = {
        niche,
        audience: audience ?? null,
        styleKeyword: styleKeyword ?? null,
        storeName: storeName ?? null,
      };
      const { plan, tokensUsed } = await generateStorePlan(
        answers,
        products.map((p) => p.title),
      );
      await recordTokenUsage(tokensUsed);
      // Same as finalizeBuilderConversation (builder-actions.ts): the plan
      // generator may pick its own name; a name the merchant gave wins.
      if (storeName?.trim()) plan.storeName = storeName.trim();
      const theme = themeForStyle(styleKeyword);
      const productsMatchedNiche = productsMatchNiche(products, niche);

      const draft = await ensureDraftStore({
        name: plan.storeName,
        theme,
        plan,
        products: products.map((p) => ({ id: p.id, price: p.retail_price })),
      });
      if (draft.error || !draft.storeId) return `Couldn't create the store: ${draft.error ?? "unknown error"}`;

      return JSON.stringify({
        storeId: draft.storeId,
        reviewUrl: `/builder?draft=${draft.storeId}`,
        storeName: plan.storeName,
        tagline: plan.tagline,
        theme,
        productCount: products.length,
        productsMatchedNiche,
        note: [
          "This is a real, saved draft — not live yet. Call launch_store with this storeId only if the merchant explicitly wants it live now.",
          productsMatchedNiche
            ? null
            : `productsMatchedNiche is false: none of the ${products.length} products on this draft actually match "${niche}" — the catalog had nothing for that niche, so it was built around whatever was available. Say so plainly in your reply (the merchant will want to swap the products, or pick a niche the catalog covers) — never present this as a store built around ${niche}.`,
        ]
          .filter(Boolean)
          .join(" "),
      });
    },
    {
      name: "build_store",
      description:
        "Build a real store around an idea: generates a full store plan (name, tagline, colors, hero copy, SEO) and saves it as a genuine draft the merchant can open and review. Pass productIds from a prior suggest_products call to build around specific picks, or omit it to auto-pick products for the niche. A storeName the merchant gave is used verbatim. The result's productsMatchedNiche tells you whether the products on the draft actually match the niche — if false, say so plainly, never present it as a store built around that niche. Does NOT make the store live — call launch_store separately for that.",
      schema: z.object({
        niche: z.string().describe("What the store sells, e.g. 'handmade leather bags'"),
        audience: z.string().optional().describe("Who buys it / where"),
        styleKeyword: z.string().optional().describe("Visual vibe, e.g. 'luxury', 'playful', 'minimal'"),
        storeName: z.string().optional().describe("Store name, if the merchant gave one"),
        productIds: z.array(z.string()).optional().describe("Specific product ids to build around"),
      }),
    },
  );

  const launchStore = tool(
    async ({ storeId }: { storeId: string }) => {
      const supabase = await createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return "Not authenticated.";
      const { data: store } = await supabase
        .from("stores")
        .select("id, name, type, theme, logo_url, content, draft_products, launched_at")
        .eq("id", storeId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!store) return "Store not found, or it doesn't belong to this merchant.";
      if (store.launched_at) return "This store is already live.";

      const result = await launchStoreCore({
        draftId: store.id,
        name: store.name ?? "My Store",
        type: store.type as StoreType,
        theme: store.theme ?? "aurora",
        logoUrl: store.logo_url,
        plan: store.content as unknown as StorePlan,
        products: (store.draft_products ?? []) as { id: string; price: number | null }[],
      });
      if ("error" in result) return `Couldn't launch: ${result.error}`;
      return JSON.stringify({ storeId: result.storeId, liveUrl: result.liveUrl, note: "The store is now live." });
    },
    {
      name: "launch_store",
      description:
        "Make a draft store live. Only call this when the merchant explicitly asks for the store to go live or be published — never automatically right after building it.",
      schema: z.object({ storeId: z.string() }),
    },
  );

  const editStoreContent = tool(
    async ({ storeId, instruction }: { storeId: string; instruction: string }) => {
      const result = await editStore(storeId, instruction);
      if (result.error) return result.error;
      if (result.productSuggestions?.length) {
        return JSON.stringify({
          note: result.note,
          productSuggestions: result.productSuggestions.map((p) => ({
            id: p.id,
            title: p.title,
            retailPrice: p.retail_price,
          })),
        });
      }
      return result.note ?? "Done.";
    },
    {
      name: "edit_store_content",
      description:
        "Edit an existing store's own content — headline, tagline, brand colors, about text, SEO title/description, collections, announcement bar, footer, or a whole custom page (Contact Us, FAQ, etc). Also the right tool for SEO analysis/improvement requests for this store. NEVER use this for a blog post — a blog post is a completely separate feature (see write_blog_post) from a custom page, even though both start from 'add a...'. Give the full instruction in plain English, e.g. 'improve the SEO' or 'make the headline shorter and use a deep green'. The editor sees ONLY this instruction — none of this conversation — so make it fully self-contained: include the store name, and any target market, keywords, products, audience, tone or constraint the merchant mentioned earlier in this conversation (e.g. 'improve the SEO for Coastal Co — target market is the UK, main keywords leather bags and handmade satchels').",
      schema: z.object({ storeId: z.string(), instruction: z.string() }),
    },
  );

  const writeBlogPost = tool(
    async ({ storeId, topic }: { storeId: string; topic: string }) => {
      const result = await generatePostDraft(storeId, topic);
      if (result.error) return result.error;
      const post = result.post!;
      return JSON.stringify({
        title: post.title,
        slug: post.slug,
        status: post.status,
        note: `Saved as a draft on this store's Blog screen — it's not published yet, the merchant still reviews it there first.`,
      });
    },
    {
      name: "write_blog_post",
      description:
        "The Blog Draft Writer: write a REAL blog post for a store from a topic — the same AI writing engine the store's own Blog screen uses (full title, excerpt, body, SEO fields), saved as a real draft post there, never published automatically. This is the ONLY tool for 'write/add a blog post' — never edit_store_content or build_store, which have no idea blog posts exist as their own feature (store_posts, not a custom page or plan content). For more than one post, call this once per topic.",
      schema: z.object({ storeId: z.string(), topic: z.string().describe("What the post should be about") }),
    },
  );

  const askAdvisor = tool(
    async ({ storeId, question }: { storeId: string; question: string }) => {
      const advisor = await askBusinessAdvisor({ tenantId: opts.tenantId, storeId, message: question });
      return advisor.reply;
    },
    {
      name: "ask_business_advisor",
      description:
        "Get a real, grounded answer about ONE specific store's own numbers, orders, catalog, or (for a connected Shopify store) live shop status — has direct read access to that store's actual data. Use for a deep or precise question about one named store, not a portfolio-wide question (the snapshot already covers those) — e.g. 'why are Nomad Threads' conversions down' or 'what's actually in Coastal Co's catalog right now' calls this tool; 'which of my stores has the weakest SEO' or 'how's the business doing overall' stays with the snapshot you already have, even though both compare across stores in some sense — the line is whether the answer needs ONE store's live/detailed data (this tool) or is answerable from the portfolio-level numbers already summarised for you (the snapshot). For a genuine per-store comparison across several stores, prefer answering from the snapshot first and only fall back to calling this once per store if the snapshot genuinely doesn't have what's being asked. The advisor sees ONLY the question — none of this conversation — so make it fully self-contained: name the store, the exact time range (dates, not 'recently'), and any products, market, keywords or focus the merchant stated earlier in this conversation.",
      schema: z.object({ storeId: z.string(), question: z.string() }),
    },
  );

  return [listMyStores, suggestProducts, buildStore, launchStore, editStoreContent, writeBlogPost, askAdvisor];
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Sparkles, Loader2, Send, Store, Globe, ShoppingBag, ImagePlus, X, Check, ExternalLink, ArrowLeft, Pencil, Trash2, Smartphone, Tablet, Monitor, Plus, Eye, Copy, Square } from "lucide-react";
import { cn } from "@ecomstrait/ui";
import { createClient } from "@ecomstrait/auth/client";
import type { StoreType } from "@ecomstrait/db";
import { DEFAULT_THEME_ID } from "@/content/themes";
import { ContentEditor } from "@/components/builder/content-editor";
import { ChatMarkdown } from "@/components/cofounder/chat-markdown";
import { requestListing } from "@/lib/listing-actions";
import { addSelectedProduct } from "@/lib/catalog-actions";
import {
  converseBuilderTurn,
  finalizeBuilderConversation,
  refineStore,
  createStore,
  editStore,
  updateStore,
  ensureDraftStore,
  saveDraft,
  discardDraft,
  saveBuilderChatHistory,
  listBuilderPreviewPages,
  type PreviewProduct,
  type BuilderTurn,
  type ConverseResult,
  type ProductSuggestion,
} from "@/lib/builder-actions";
import { storeTokens, tokenStyle } from "@/lib/theme-tokens";
import type { DraftStore } from "@/lib/drafts";
import { draftExpiryLabel } from "@/lib/store-status";
import type { StorePlan } from "@/lib/ecomai";
import { VersionHistory } from "@/components/builder/version-history";
import type { CategoryBand } from "@/components/storefront/storefront-view";
import type { Storefront } from "@/lib/storefront";
import type { ApiProduct, StorefrontNavLink } from "@/lib/storefront-api";
import { categoryLabel, UNCATEGORIZED } from "@/lib/storefront-shared";
import { BUILDER_PREVIEW_READY, BUILDER_PREVIEW_DATA, type BuilderPreviewPayload } from "@/lib/builder-preview-protocol";
import { UpgradeModal } from "@/components/billing/upgrade-modal";
import type { PageDetail } from "@/lib/pages-api";
import type { PostDetail } from "@/lib/blog-api";

/**
 * An already-launched store, opened in the same workbench used to build it.
 * When present the question flow is skipped and the chat edits the live store.
 */
export type ExistingStore = {
  id: string;
  name: string;
  type: StoreType;
  theme: string;
  logoUrl: string | null;
  liveUrl: string | null;
  plan: StorePlan;
  products: PreviewProduct[];
};

type Msg = { id: number; role: "ai" | "user"; content: string; productSuggestions?: ProductSuggestion[] };

/** Shared by `previewCategoryBands` and `previewProductsBySection` — the
 *  same shape the preview always builds a `PreviewProduct` into for
 *  anything `StorefrontView`/`ProductGrid` renders. */
function toApiProduct(p: PreviewProduct): ApiProduct {
  return {
    id: p.id,
    title: p.title,
    description: null,
    category: p.category,
    image: p.image,
    images: p.image ? [p.image] : [],
    price: p.price,
    compareAtPrice: null,
    available: 99,
    inStock: true,
    sizes: null,
    material: null,
    fitNote: null,
    shippingNote: null,
  };
}

/**
 * What the merchant already decided before arriving here — products picked in
 * Find Suppliers, a theme chosen in the gallery. Those questions get skipped
 * rather than asked again.
 */
export type BuilderContext = {
  /** Products already selected; suppresses the "what do you want to sell?" step. */
  productCount: number;
  /** Niche inferred from the selection, used in place of the answer. */
  inferredNiche: string;
  /** Theme chosen in the gallery; suppresses the style question. */
  presetTheme: string;
  presetThemeName: string;
};

/**
 * The two selling paths on offer.
 *
 * `shopify_shopify_theme` still exists in the database and is still labelled
 * elsewhere, but isn't offered here: it and `shopify_liquid_theme` both mean
 * "a Shopify store", and the difference was ours to explain rather than the
 * merchant's to choose.
 */
const PATHS: { type: StoreType; label: string; icon: typeof Store }[] = [
  { type: "own_platform", label: "Own website", icon: Globe },
  { type: "shopify_liquid_theme", label: "Shopify store", icon: Store },
];

/** Every type that can appear on an existing store, including the retired one. */
const PATH_LABELS: Record<StoreType, string> = {
  own_platform: "Own website",
  shopify_liquid_theme: "Shopify store",
  shopify_shopify_theme: "Shopify store",
};

/** Preview width per device — lets a merchant actually see the responsive
 *  layout instead of only ever viewing the preview at the editor pane's own
 *  (desktop-ish) width. `null` means no cap, i.e. today's default behavior. */
type Device = "mobile" | "tablet" | "desktop";
const DEVICES: { type: Device; label: string; icon: typeof Smartphone; maxWidth: number | null }[] = [
  { type: "mobile", label: "Mobile", icon: Smartphone, maxWidth: 390 },
  { type: "tablet", label: "Tablet", icon: Tablet, maxWidth: 768 },
  { type: "desktop", label: "Desktop", icon: Monitor, maxWidth: null },
];

export function StoreBuilder({
  userId,
  initialTheme,
  canCreateStore,
  existing,
  draft,
  context,
  initialChatMessages,
  initialPages,
  initialPosts,
}: {
  userId: string;
  initialTheme: string;
  canCreateStore: boolean;
  existing?: ExistingStore;
  /** An unlaunched build to pick back up. Ignored when editing a live store. */
  draft?: DraftStore | null;
  context?: BuilderContext;
  /** The persisted chat thread for this store (existing or resumed), last
   *  (up to) 30 messages — see `packages/ai/src/memory/chat-threads.ts`.
   *  Undefined/empty for a genuinely fresh session, which has no store id
   *  yet to have persisted anything against. */
  initialChatMessages?: { role: "user" | "assistant"; content: string }[];
  /** Custom pages (existing or resumed) — refreshed mid-session after any
   *  chat turn that might have created one, since these ARE created through
   *  this exact chat, unlike blog posts. See `listBuilderPreviewPages`. */
  initialPages?: PageDetail[];
  /** Published blog posts (existing or resumed) — written from the store's
   *  own Blog screen, not this chat, so an initial load is enough. */
  initialPosts?: PostDetail[];
}) {
  const router = useRouter();
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;

  const editing = Boolean(existing);
  // A draft is only meaningful in build mode — /stores/[id]/edit is for stores
  // that already exist, and mixing the two would offer Launch on a live store.
  const resumed = editing ? null : (draft ?? null);

  // What converseBuilderTurn needs to know is already settled — it decides
  // itself what's left to ask, rather than the client scripting which of a
  // fixed list of questions to skip.
  const knownContext = useMemo(
    () => ({
      productCount: context?.productCount,
      inferredNiche: context?.inferredNiche,
      presetTheme: context?.presetTheme,
    }),
    [context],
  );

  // `knownContext.inferredNiche` only ever reflects a pre-selection made
  // before this chat started (e.g. from Find Suppliers) — it never updates
  // as the conversation itself establishes a niche turn by turn. Without
  // this, `converseBuilderTurn`'s deterministic "are they delegating what to
  // sell?" backstop had to stay restricted to only the conversation's first
  // message, since past that point it had no reliable way to tell whether
  // niche had already been answered — a real gap: a merchant answering a
  // LATER question (audience/style) with a phrase like "you decide" risked
  // being caught by the same backstop as if they were still delegating what
  // to sell. Tracking what the AI itself has already learned mid-chat closes
  // that gap properly instead of just loosening the turn restriction.
  const [chatNiche, setChatNiche] = useState<string | null>(null);
  const turnContext = useMemo(
    () => ({ ...knownContext, inferredNiche: knownContext.inferredNiche ?? chatNiche ?? undefined }),
    [knownContext, chatNiche],
  );

  const [messages, setMessages] = useState<Msg[]>(
    initialChatMessages?.length
      ? initialChatMessages.map((m, i) => ({ id: i, role: m.role === "assistant" ? "ai" : "user", content: m.content }))
      : existing
      ? [
          {
            id: 0,
            role: "ai",
            content: `"${existing.name}" is loaded on the right. Tell me what to change — colours, the headline, the tagline — and I'll update your live store.`,
          },
        ]
      : resumed
      ? [
          {
            id: 0,
            role: "ai",
            content: `Welcome back — I've reloaded "${resumed.name}", the store you were building. Nothing's public yet, so ask for any tweaks and hit Launch my store when you're happy.`,
          },
          {
            id: 1,
            role: "ai",
            // Said plainly up front. A merchant who leaves this open for a week
            // should have been told the draft goes away, not discover it gone.
            content: `Heads up: an untouched draft ${draftExpiryLabel(resumed.updatedAt)}. Every edit resets that, and launching keeps it for good.`,
          },
        ]
      : [
          { id: 0, role: "ai", content: "Hi! I'm EcomAI, your co-founder. Let's build your store together." },
          ...(context && (context.productCount || context.presetTheme)
            ? [
                {
                  id: 1,
                  role: "ai" as const,
                  // Explicit and directive when arriving with a basket from Find
                  // Suppliers — that merchant clicked "Create a store with
                  // selected inventory" specifically so those exact products get
                  // used, not auto-picked by AI, so this says so plainly and asks
                  // right away for what's still needed (name + brand) instead of
                  // leaving that to whatever the model's own next question is.
                  content: [
                    context.productCount
                      ? `Your ${context.productCount} selected product${context.productCount === 1 ? "" : "s"} ${
                          context.productCount === 1 ? "is" : "are"
                        } already added — I'll build the store around ${
                          context.productCount === 1 ? "it" : "them"
                        }, not pick my own.`
                      : "",
                    context.presetThemeName ? `I've also got the ${context.presetThemeName} theme you picked.` : "",
                    context.productCount
                      ? "Just tell me the store name and a bit about your brand — style, colours, who it's for — and I'll set up the rest."
                      : "So I'll skip that question.",
                  ]
                    .filter(Boolean)
                    .join(" "),
                },
              ]
            : []),
        ],
  );
  const [stage, setStage] = useState<"asking" | "ready">(
    existing || resumed ? "ready" : "asking",
  );
  // The running transcript sent to converseBuilderTurn — separate from
  // `messages` (which also carries the greeting bubbles above, not part of
  // the actual conversation the AI is reasoning over). Seeded from the
  // persisted thread when resuming a draft, so the "asking" stage — the one
  // stage that actually threads history to the model — remembers a Q&A that
  // was left unfinished, not just re-shows it on screen.
  const [history, setHistory] = useState<BuilderTurn[]>(initialChatMessages ?? []);

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // `busy` is plain state (not `useTransition`), which is what makes Stop
  // possible at all — these are Server Actions with no cancellation
  // primitive, so nothing actually aborts the in-flight request; this just
  // guards against ITS eventual result still landing after the visitor
  // already gave up on it. Reset at the start of every new send, not just
  // on stop.
  const cancelledRef = useRef(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [plan, setPlan] = useState<StorePlan | null>(existing?.plan ?? resumed?.plan ?? null);
  const [products, setProducts] = useState<PreviewProduct[]>(
    existing?.products ?? resumed?.products ?? [],
  );

  const [name, setName] = useState(existing?.name ?? resumed?.name ?? "");
  const [type, setType] = useState<StoreType>(existing?.type ?? resumed?.type ?? "own_platform");
  const [device, setDevice] = useState<Device>("desktop");
  const [theme, setTheme] = useState(
    existing?.theme || resumed?.theme || context?.presetTheme || initialTheme || DEFAULT_THEME_ID,
  );
  const [logoUrl, setLogoUrl] = useState<string | null>(
    existing?.logoUrl ?? resumed?.logoUrl ?? null,
  );
  const [uploading, setUploading] = useState(false);
  const [editingContent, setEditingContent] = useState(false);
  // Below `lg`, chat and preview used to split the workbench 50/50 — on a
  // real phone that's two panels too short to use at all, chat especially
  // once the on-screen keyboard opens. Only one shows at a time on mobile
  // now, each getting the whole panel's height; `lg:` and up still shows
  // both side by side as before, so this only affects small screens.
  const [mobileView, setMobileView] = useState<"chat" | "preview">("chat");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgradeMsg, setUpgradeMsg] = useState<string | null>(null);

  /**
   * The unlaunched store row backing this build.
   *
   * It's what gives the content editor and the media library something to
   * attach to before Launch — an upload needs a store id to belong to.
   */
  const [draftId, setDraftId] = useState<string | null>(resumed?.id ?? null);
  const [discarding, setDiscarding] = useState(false);
  /** The id whose media the editor addresses: a live store, or the draft. */
  const mediaStoreId = existing?.id ?? draftId;

  // Custom pages and blog posts, for the preview — see the props' own doc
  // comments for why pages get refreshed mid-session and posts don't.
  const [pages, setPages] = useState<PageDetail[]>(initialPages ?? []);
  const [posts] = useState<PostDetail[]>(initialPosts ?? []);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  /**
   * Keep the draft in step with the workbench.
   *
   * Debounced so typing a store name isn't one write per keystroke, and it
   * doubles as the TTL heartbeat: each save moves `updated_at`, so a draft
   * someone is actively working on can't expire underneath them.
   *
   * Launched stores are excluded — those save explicitly, and writing on every
   * keystroke would push half-typed changes onto a live storefront.
   */
  useEffect(() => {
    if (!draftId || editing || !plan) return;
    const t = setTimeout(() => {
      void saveDraft(draftId, {
        name,
        theme,
        logoUrl,
        plan,
        products: products.map((x) => ({ id: x.id, price: x.price })),
      });
    }, 1200);
    return () => clearTimeout(t);
  }, [draftId, editing, plan, name, theme, logoUrl, products]);

  function pushAi(content: string, productSuggestions?: ProductSuggestion[]) {
    setMessages((m) => [...m, { id: nextId(), role: "ai", content, productSuggestions }]);
  }

  /** Give up on the in-flight reply — for a prompt sent by mistake, no point
   *  waiting out (or later being confused by) an answer to it. */
  function stop() {
    cancelledRef.current = true;
    setBusy(false);
  }

  function copyMessage(id: number, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1200);
    });
  }

  // The conversation's opening question is the AI's own, not a hardcoded
  // string — asking with an empty transcript is exactly how it decides what
  // (if anything, given `knownContext`) it still needs to know first.
  useEffect(() => {
    if (existing || resumed || stage !== "asking" || history.length > 0) return;
    let cancelled = false;
    (async () => {
      // Deferred a tick so `setBusy` never fires synchronously inside the
      // effect body itself — it still shows well before the network call
      // resolves.
      await Promise.resolve();
      if (cancelled) return;
      setBusy(true);
      const res = await converseBuilderTurn([], turnContext);
      if (cancelled || cancelledRef.current) return;
      setBusy(false);
      if ("error" in res) {
        if (res.upgrade) setUpgradeMsg(res.error);
        else pushAi(res.error);
        return;
      }
      if (res.niche) setChatNiche(res.niche);
      setHistory([{ role: "assistant", content: res.reply }]);
      pushAi(res.reply, res.productSuggestions);
    })();
    return () => {
      cancelled = true;
    };
    // Only ever runs once, on mount — `history.length > 0` guards any re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runBuild(
    answers: {
      niche: string | null;
      audience: string | null;
      styleKeyword: string | null;
      storeName: string | null;
    },
    // Passed explicitly rather than read from the `history` state closure:
    // this runs synchronously right after `setHistory(...)` in `send()`
    // below, before React has applied that update, so `history` here would
    // still be one turn behind — missing exactly the exchange that just
    // finished the conversation.
    transcript: BuilderTurn[],
  ) {
    setBusy(true);
    pushAi(
      context?.productCount
        ? "Building your store now around the products you picked: writing copy, generating SEO, and applying a theme…"
        : "Building your store now: picking products, writing copy, generating SEO, and applying a theme…",
    );
    const res = await finalizeBuilderConversation(
      { niche: answers.niche || context?.inferredNiche || "a new store", audience: answers.audience, styleKeyword: answers.styleKeyword, storeName: answers.storeName },
      // Unconditional, not `Boolean(context?.productCount)` — that only
      // reflected what was selected at page load, so a product added mid-
      // conversation via a suggestion card (after load, before this runs)
      // was silently ignored. `finalizeBuilderConversation` already falls
      // back to auto-picking when `selected_products` is empty, so this is
      // strictly more correct with no downside for the empty case.
      { useSelected: true },
    );
    if (cancelledRef.current) return; // Stopped — don't apply a build the visitor already gave up on.
    setBusy(false);
    if (res.error) {
      if (res.upgrade) setUpgradeMsg(res.error);
      else pushAi(res.error);
      return;
    }
    const p = res.plan!;
    setPlan(p);
    setProducts(res.products ?? []);
    setName(p.storeName);
    // A theme chosen in the gallery wins over the one EcomAI would infer.
    if (res.theme && !context?.presetTheme) setTheme(res.theme);
    setStage("ready");
    // Told first, before the generic "Done!" — the merchant needs to know
    // their earlier selection didn't win before seeing unfamiliar products.
    if (res.note) pushAi(res.note);
    pushAi(
      `Done! I built "${p.storeName}" with ${res.products?.length ?? 0} products lined up, a matching theme, and SEO. Take a look at the preview — want any tweaks? (e.g. "make it navy", "punchier headline"). When it's ready, set how you want to sell and hit Launch my store — that's when these products actually go out to each supplier's approval queue, not before.`,
    );
    // On mobile, chat and preview are tabs, not a side-by-side split — the
    // message above just told them to "take a look", so actually show it.
    setMobileView("preview");

    // Persist it as a draft now that there's something to persist. This is what
    // unlocks Content and the media library before Launch — both address a
    // store by id, so until a row exists there's nothing to upload against.
    const draftRes = await ensureDraftStore({
      draftId,
      name: p.storeName,
      theme: res.theme && !context?.presetTheme ? res.theme : theme,
      logoUrl,
      plan: p,
      products: (res.products ?? []).map((x) => ({ id: x.id, price: x.price })),
    });
    if (draftRes.storeId) {
      setDraftId(draftRes.storeId);
      pushAi(
        "I've saved this as a draft, so you can edit the text and swap in your own images and video from Content before anything goes live.",
      );
      // First time a store id exists for this session — bulk-save the whole
      // opening conversation now, since there was nothing to key it on
      // before this point. Fire-and-forget: a history-saving hiccup should
      // never block or error out a build that already succeeded.
      void saveBuilderChatHistory(draftRes.storeId, transcript);
    } else if (draftRes.error) {
      // Non-fatal: the build is still on screen and still launchable, the
      // merchant just can't upload media until the draft saves.
      setError(`${draftRes.error} Your build is safe — Launch still works.`);
    }
  }

  async function send() {
    const text = input.trim();
    if (text.length < 1 || busy) return;
    setInput("");
    setError(null);
    setMessages((m) => [...m, { id: nextId(), role: "user", content: text }]);
    cancelledRef.current = false;

    if (stage === "asking") {
      setBusy(true);
      const nextHistory: BuilderTurn[] = [...history, { role: "user", content: text }];
      const res: (ConverseResult & { productSuggestions?: ProductSuggestion[] }) | { error: string; upgrade?: boolean } =
        await converseBuilderTurn(nextHistory, turnContext);
      if (cancelledRef.current) return;
      setBusy(false);
      if ("error" in res) {
        if (res.upgrade) setUpgradeMsg(res.error);
        else pushAi(res.error);
        return;
      }
      if (res.niche) setChatNiche(res.niche);
      const finalHistory: BuilderTurn[] = [...nextHistory, { role: "assistant", content: res.reply }];
      setHistory(finalHistory);
      pushAi(res.reply, res.productSuggestions);
      if (res.done) {
        await runBuild(res, finalHistory);
      }
      return;
    }

    // ready → cosmetic refinement
    if (!plan) return;
    setBusy(true);

    // Editing a launched store persists and propagates; building only updates
    // the in-memory preview until "Launch my store".
    if (existing) {
      const res = await editStore(existing.id, text);
      if (cancelledRef.current) return;
      setBusy(false);
      if (res.error) {
        if (res.upgrade) setUpgradeMsg(res.error);
        else pushAi(`⚠️ ${res.error}`);
        return;
      }
      if (res.plan) {
        setPlan(res.plan);
        // `name` (this input field, the preview title bar, and — pre-launch
        // only — what gets sent to Launch) is a separate mirror of
        // `plan.storeName`, not derived from it. A real bug this fixed: the
        // AI would rename the store in `plan.storeName` and confidently say
        // so, but nothing here ever copied that into `name`, so the field
        // and the preview chrome kept showing the old name and made a real
        // rename look like it silently failed.
        setName(res.plan.storeName);
      }
      pushAi(res.note ?? "Updated.", res.productSuggestions);
      // Fire-and-forget: a custom page is the one thing the preview shows
      // that's actually created *through this chat* — refresh it after
      // every ready-stage turn (cheap, one indexed query) rather than
      // trying to detect precisely which turns touched a page.
      void refreshPreviewPages(existing.id);
      router.refresh();
      return;
    }

    const res = await refineStore(plan, text, draftId);
    if (cancelledRef.current) return;
    setBusy(false);
    if (res.error) {
      if (res.upgrade) setUpgradeMsg(res.error);
      else pushAi(res.error);
      return;
    }
    // EcomAI answers questions as well as making changes, so only repaint the
    // preview when it reports an actual edit — and always show its own words
    // rather than a fixed "Updated", which said nothing when it had in fact
    // answered a question or refused something it can't do.
    if (res.changed?.length && res.plan) {
      setPlan(res.plan);
      // Same sync as the live-edit branch above — pre-launch, this also
      // matters for the debounced autosave effect, which sends this `name`
      // state (not `plan.storeName`) to `saveDraft`, and for `create()`,
      // which does the same to `createStore` on Launch.
      setName(res.plan.storeName);
    }
    pushAi(res.reply ?? "Updated — check the preview.", res.productSuggestions);
    if (draftId) void refreshPreviewPages(draftId);
  }

  /** See the `send()` call sites above — never awaited there, a page-list
   *  refresh failing shouldn't disrupt a chat turn that already succeeded. */
  async function refreshPreviewPages(storeId: string) {
    const fresh = await listBuilderPreviewPages(storeId);
    setPages(fresh);
  }

  const [addingProductId, setAddingProductId] = useState<string | null>(null);
  const [addedProductIds, setAddedProductIds] = useState<Set<string>>(new Set());

  /**
   * A merchant clicking "Add" on a suggested product. Editing a live store,
   * it's a real listing request, same action Find Suppliers uses.
   *
   * Pre-launch, it's client-side state for immediate feedback (the same
   * `products` array `createStore`/`saveDraft` send) — but during the
   * opening conversation specifically, it ALSO has to land in the real
   * `selected_products` table via `addSelectedProduct`, the same one Find
   * Suppliers writes to. Without that, a product added here looked added in
   * the chat but silently vanished the moment `runBuild()` below actually
   * built the store — `finalizeBuilderConversation`'s `useSelected` reads
   * that table, not this component's local state, to decide what to build
   * around.
   */
  async function addSuggestedProduct(p: ProductSuggestion) {
    setAddingProductId(p.id);
    try {
      if (existing) {
        const res = await requestListing(existing.id, p.id);
        if (res.error) {
          setError(res.error);
          return;
        }
        router.refresh();
      } else {
        if (stage === "asking") {
          const res = await addSelectedProduct(p.id);
          if (res.error) {
            setError(res.error);
            return;
          }
        }
        setProducts((prev) =>
          prev.some((x) => x.id === p.id)
            ? prev
            : [...prev, { id: p.id, title: p.title, price: p.retail_price, image: productImageFor(p), category: p.category }],
        );
      }
      setAddedProductIds((prev) => new Set(prev).add(p.id));
    } finally {
      setAddingProductId(null);
    }
  }

  function productImageFor(p: ProductSuggestion): string | null {
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const path = p.images?.[0];
    return path && base ? `${base}/storage/v1/object/public/product-images/${path}` : null;
  }

  async function onLogo(file: File) {
    setUploading(true);
    setError(null);
    try {
      const supabase = createClient();
      const ext = file.name.split(".").pop() || "png";
      const path = `${userId}/logo.${ext}`;
      const { error: upErr } = await supabase.storage.from("store-logos").upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      const url = supabase.storage.from("store-logos").getPublicUrl(path).data.publicUrl;
      // cache-bust so a re-upload shows immediately
      setLogoUrl(`${url}?v=${file.size}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Logo upload failed.");
    } finally {
      setUploading(false);
    }
  }

  /** Edit mode: persist the settings that aren't part of the AI plan. */
  async function save() {
    if (!existing) return;
    setSaving(true);
    setError(null);
    setSavedAt(false);
    // Send the plan too: the content editor writes straight into `plan`, and
    // updateStore only persists it when it actually differs.
    const res = await updateStore(existing.id, {
      name,
      theme,
      logoUrl,
      ...(plan ? { content: plan } : {}),
    });
    setSaving(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setSavedAt(true);
    if (res.note) pushAi(res.note);
    router.refresh();
  }

  async function discard() {
    if (!draftId) return;
    setDiscarding(true);
    setError(null);
    const res = await discardDraft(draftId);
    setDiscarding(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    // A real full reload, not router.replace/refresh — this is the SAME
    // route the component is already mounted on, so a client-side
    // navigation re-renders it with new server props but never remounts it,
    // leaving every piece of state (plan, products, messages, draftId) from
    // the discarded draft sitting on screen even though the row is gone.
    // "Discard" means start over, so a hard navigation is the correct tool
    // here, not a shortcut around a bug.
    window.location.href = "/builder";
  }

  async function create() {
    if (!plan) return;
    // Checked client-side first (canCreateStore is passed in from the server)
    // so hitting the limit shows the Upgrade popup immediately instead of a
    // disabled button with no explanation — createStore() below still
    // enforces the same limit server-side as a backstop.
    if (!canCreateStore) {
      setUpgradeMsg("You've reached your plan's store limit. Upgrade to launch more stores.");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await createStore({
      // Promote the row we've been editing instead of inserting a new one, so
      // the media uploaded during the build stays attached to the live store.
      draftId,
      name,
      type,
      theme,
      logoUrl,
      plan,
      products: products.map((p) => ({ id: p.id, price: p.price })),
    });
    if (res && "error" in res && res.error) {
      if (res.upgrade) setUpgradeMsg(res.error);
      else setError(res.error);
      setSaving(false);
    } else {
      router.refresh();
    }
  }

  // Preview props for the real StorefrontView, built from state already
  // here — draft/unlaunched stores are deliberately refused by
  // getStorefront/getStorefrontNav (storefront.ts), so this can't call the
  // same server functions the live route does; it constructs the same
  // shapes locally instead. Recomputed only when the underlying state
  // actually changes, not on every render (this panel re-renders on every
  // chat token).
  const previewStore: Storefront | null = useMemo(() => {
    if (!plan) return null;
    return {
      id: existing?.id ?? draftId ?? "preview",
      name: name || plan.storeName,
      logoUrl,
      theme,
      status: "draft",
      plan,
      products: products.map((p) => ({ id: p.id, title: p.title, image: p.image, price: p.price, supplierId: null })),
    };
  }, [plan, existing?.id, draftId, name, logoUrl, theme, products]);

  const previewCategoryBands: CategoryBand[] = useMemo(() => {
    if (!products.length) return [];
    const groups = new Map<string, PreviewProduct[]>();
    for (const p of products) {
      const key = p.category?.trim() || UNCATEGORIZED;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    return [...groups.entries()].map(([category, items]) => ({
      category,
      products: items.map(toApiProduct),
      total: items.length,
    }));
  }, [products]);

  // "products"-type content sections (e.g. "Best sellers") only store
  // `productIds` — resolved here against the store's own already-loaded
  // `products` state, the same way `previewCategoryBands` already resolves
  // real product data, so the preview shows exactly what the live site will
  // once launched (storefront-pages.tsx resolves the same section type the
  // same way, server-side, for the real homepage).
  const previewProductsBySection = useMemo(() => {
    const bySection: Record<string, ApiProduct[]> = {};
    const byId = new Map(products.map((p) => [p.id, p]));
    for (const section of plan?.sections ?? []) {
      if (section.type !== "products") continue;
      bySection[section.id] = (section.productIds ?? [])
        .map((id) => byId.get(id))
        .filter((p): p is PreviewProduct => Boolean(p))
        .map(toApiProduct);
    }
    return bySection;
  }, [plan?.sections, products]);

  const previewNavLinks: StorefrontNavLink[] = useMemo(() => {
    const categoryLinks: StorefrontNavLink[] = previewCategoryBands
      .filter((b) => b.category !== UNCATEGORIZED)
      .map((b) => ({ label: categoryLabel(b.category), href: `/store/preview/products?category=${encodeURIComponent(b.category)}` }));
    // Same bundling `getStorefrontNav` (the real nav builder) uses — a single
    // category stays a direct link, more than one collapses into one
    // "Categories" dropdown entry instead of one tab per category.
    const links: StorefrontNavLink[] = [];
    if (categoryLinks.length === 1) {
      links.push(categoryLinks[0]);
    } else if (categoryLinks.length > 1) {
      links.push({ label: "Categories", href: "/store/preview/products", children: categoryLinks });
    }
    links.push({ label: "Shop all", href: "/store/preview/products" });
    // Same ordering getStorefrontNav (the real nav builder) already uses —
    // Blog only when there's something to show, custom pages last.
    if (posts.length > 0) links.push({ label: "Blog", href: "/store/preview/blog" });
    links.push({ label: "Sale", href: "/store/preview#sale" });
    if (plan?.about) links.push({ label: "About", href: "/store/preview#about" });
    for (const p of pages) links.push({ label: p.title, href: `/store/preview/${p.slug}` });
    return links;
  }, [previewCategoryBands, plan?.about, posts, pages]);

  // Preview panel lives in an <iframe> (builder-preview-frame/page.tsx) so
  // the Mobile/Tablet/Desktop toggle actually changes its real viewport
  // width, not just a letterboxed container — see that file for why a
  // width-constrained <div> can't do this. Talk to it over postMessage: it
  // has no server data of its own, so every render depends on us sending
  // the current draft state across.
  //
  // The "Live Preview" button (top-right of this pane) opens the exact same
  // page in a real tab via window.open() instead — same protocol, same
  // payload, it just doesn't care which kind of window asked. That's what
  // makes one button correct for both a draft that's never been published
  // and a live store mid-edit: either way it's showing the current,
  // possibly-unsaved state, not a stale published copy.
  const previewFrameRef = useRef<HTMLIFrameElement>(null);
  const previewFrameReady = useRef(false);
  const previewWindowRef = useRef<Window | null>(null);
  const previewWindowReady = useRef(false);

  useEffect(() => {
    function sendTo(win: Window | null, readyRef: { current: boolean }) {
      if (!readyRef.current || !win || win.closed || !previewStore) return;
      const payload: BuilderPreviewPayload = {
        store: previewStore,
        navLinks: previewNavLinks,
        categoryBands: previewCategoryBands,
        pages,
        posts,
        productsBySection: previewProductsBySection,
      };
      win.postMessage({ type: BUILDER_PREVIEW_DATA, payload }, window.location.origin);
    }
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type !== BUILDER_PREVIEW_READY) return;
      const fromFrame = e.source === previewFrameRef.current?.contentWindow;
      const fromWindow = e.source === previewWindowRef.current;
      if (fromFrame) {
        previewFrameReady.current = true;
        sendTo(previewFrameRef.current?.contentWindow ?? null, previewFrameReady);
      } else if (fromWindow) {
        previewWindowReady.current = true;
        sendTo(previewWindowRef.current, previewWindowReady);
      }
    }
    window.addEventListener("message", onMessage);
    sendTo(previewFrameRef.current?.contentWindow ?? null, previewFrameReady);
    sendTo(previewWindowRef.current, previewWindowReady);
    return () => window.removeEventListener("message", onMessage);
  }, [previewStore, previewNavLinks, previewCategoryBands, pages, posts, previewProductsBySection]);

  function openLivePreview() {
    // A named target: clicking the button again while the tab is still open
    // refocuses that same tab instead of piling up duplicates.
    const win = window.open("/builder-preview-frame", "ecomstrait-live-preview");
    if (!win) return; // popup blocked — nothing more we can do here
    if (win !== previewWindowRef.current) previewWindowReady.current = false;
    previewWindowRef.current = win;
    win.focus();
  }

  return (
    <div className="flex h-[80vh] min-h-[560px] flex-col overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-xl shadow-ink-950/5 lg:flex-row">
      {/* Mobile-only Chat/Preview switch — see `mobileView`'s note above. */}
      <div className="flex shrink-0 border-b border-ink-100 lg:hidden">
        {(["chat", "preview"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setMobileView(v)}
            className={cn(
              "flex-1 border-b-2 py-2.5 text-center text-sm font-semibold capitalize transition",
              mobileView === v ? "border-brand-500 text-brand-700" : "border-transparent text-ink-400",
            )}
          >
            {v}
          </button>
        ))}
      </div>

      {/* ---- Left: chat ---- */}
      <div
        className={cn(
          "w-full flex-col border-b border-ink-100 lg:flex lg:h-full lg:w-[38%] lg:border-b-0 lg:border-r",
          mobileView === "chat" ? "flex h-full" : "hidden",
        )}
      >

        <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-ai-600 text-white">
              <Sparkles className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-bold text-ink-950">EcomAI</p>
              <p className="text-xs text-ink-400">Your Business Co-founder</p>
            </div>
          </div>
          {editing && (
            <Link
              href="/stores"
              className="inline-flex items-center gap-1 text-xs font-medium text-ink-500 hover:text-ink-900"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Stores
            </Link>
          )}
        </div>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
          {messages.map((m) => (
            <div key={m.id} className={cn("flex flex-col", m.role === "user" ? "items-end" : "items-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm",
                  m.role === "user" ? "whitespace-pre-wrap bg-brand-500 text-white" : "bg-ink-100 text-ink-800",
                )}
              >
                {/* AI replies render through the same markdown-lite parser the
                    cofounder chat uses — without it, a reply that happens to
                    include **bold** (the model isn't perfectly reliable about
                    the "plain text only" instruction in its prompt) shows up
                    as literal asterisks instead of formatted text. */}
                {m.role === "ai" ? <ChatMarkdown text={m.content} /> : m.content}
              </div>
              <button
                type="button"
                onClick={() => copyMessage(m.id, m.content)}
                aria-label="Copy message"
                className="mt-1 inline-flex items-center gap-1 px-1 text-[11px] font-medium text-ink-400 transition hover:text-ink-700"
              >
                {copiedId === m.id ? (
                  <>
                    <Check className="h-3 w-3 text-brand-600" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" /> Copy
                  </>
                )}
              </button>
              {m.productSuggestions && m.productSuggestions.length > 0 && (
                <div className="mt-2 grid w-full max-w-[95%] grid-cols-2 gap-2 sm:grid-cols-3">
                  {m.productSuggestions.map((p) => {
                    const added = addedProductIds.has(p.id);
                    return (
                      <div key={p.id} className="overflow-hidden rounded-xl border border-ink-200 bg-white">
                        <div className="relative aspect-square w-full bg-ink-50">
                          {productImageFor(p) ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={productImageFor(p)!} alt={p.title} className="absolute inset-0 h-full w-full object-cover" />
                          ) : (
                            <div className="absolute inset-0 grid place-items-center text-ink-300">
                              <ShoppingBag className="h-6 w-6" />
                            </div>
                          )}
                        </div>
                        <div className="p-2">
                          <p className="line-clamp-1 text-xs font-semibold text-ink-900">{p.title}</p>
                          <p className="line-clamp-1 text-[10px] text-ink-500">{p.reason}</p>
                          <button
                            onClick={() => addSuggestedProduct(p)}
                            disabled={added || addingProductId === p.id}
                            className={cn(
                              "mt-1.5 inline-flex w-full items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition disabled:opacity-60",
                              added ? "border border-brand-200 bg-brand-50 text-brand-700" : "bg-brand-500 text-white hover:bg-brand-600",
                            )}
                          >
                            {addingProductId === p.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : added ? (
                              <>
                                <Check className="h-3 w-3" /> Added
                              </>
                            ) : (
                              <>
                                <Plus className="h-3 w-3" /> Add
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="inline-flex items-center gap-2 rounded-2xl bg-ink-100 px-3.5 py-2 text-sm text-ink-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Working…
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-ink-100 p-3">
          <div className="flex items-end gap-2 rounded-xl border border-ink-200 bg-white p-1.5">
            <textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={stage === "ready" ? "Ask for a tweak…" : "Type your answer…"}
              className="max-h-24 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-ink-400"
            />
            {busy ? (
              <button
                type="button"
                onClick={stop}
                aria-label="Stop"
                title="Stop — sent the wrong thing?"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-red-200 bg-red-50 text-red-600 transition hover:bg-red-100"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            ) : (
              <button onClick={send} disabled={input.trim().length < 1} aria-label="Send" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-500 text-white transition hover:bg-brand-600 disabled:opacity-50">
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
          {/* Logo import */}
          <div className="mt-2 flex items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-50">
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
              {logoUrl ? "Change logo" : "Upload logo"}
              <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && onLogo(e.target.files[0])} />
            </label>
            {logoUrl && (
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-ink-50 px-2 py-1 text-xs text-ink-500">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logoUrl} alt="logo" className="h-4 w-4 rounded object-contain" /> Logo added
                <button onClick={() => setLogoUrl(null)} aria-label="Remove logo"><X className="h-3 w-3" /></button>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ---- Right: preview + action bar ---- */}
      <div
        className={cn(
          "flex-1 flex-col bg-ink-50/50 lg:flex lg:h-full",
          mobileView === "preview" ? "flex h-full" : "hidden",
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
          <p className="text-sm font-bold text-ink-950">Preview</p>
          <button
            type="button"
            onClick={openLivePreview}
            disabled={!previewStore}
            title={
              previewStore
                ? "Open the current version in a new tab — reflects unsaved changes too"
                : "Available once your store has a name and products"
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-ink-700 transition hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Eye className="h-3.5 w-3.5" /> Live Preview
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          {editingContent && plan && mediaStoreId ? (
            <div className="h-full overflow-y-auto p-4">
              <div className="rounded-xl border border-ink-100 bg-white p-4 shadow-sm">
                <ContentEditor
                  storeId={mediaStoreId}
                  plan={plan}
                  onChange={(next) => {
                    setPlan(next);
                    setSavedAt(false);
                  }}
                />
              </div>
            </div>
          ) : !plan ? (
            <div className="grid h-full place-items-center p-8 text-center">
              <div className="max-w-xs">
                <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-ink-100 text-ink-400">
                  <Store className="h-7 w-7" />
                </span>
                <p className="mt-4 text-sm text-ink-500">Answer EcomAI&apos;s questions and your full store appears here.</p>
              </div>
            </div>
          ) : previewStore ? (
            // A fixed-height panel, not a growing one: the box below stays
            // exactly this tall no matter which device is selected, and the
            // <iframe> inside scrolls its own content. The previous version
            // tried to resize the box to match the iframe's content height
            // on every device switch (via postMessage), which raced the
            // width transition — the box kept resizing mid-animation, which
            // is the "buttons moving" jank. Fixed height, one scrollbar,
            // done.
            <div className="flex h-full flex-col p-4">
              {/* Lets a merchant actually see the responsive layout — the
                  preview otherwise only ever renders at this pane's own
                  (desktop-ish) width, so a mobile layout bug would never be
                  visible here even once fixed. */}
              <div className="mb-3 flex shrink-0 justify-center">
                <div className="flex items-center gap-1 rounded-lg border border-ink-200 p-0.5">
                  {DEVICES.map((d) => (
                    <button
                      key={d.type}
                      type="button"
                      onClick={() => setDevice(d.type)}
                      title={d.label}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition",
                        device === d.type ? "bg-ink-950 text-white" : "text-ink-600 hover:bg-ink-100",
                      )}
                    >
                      <d.icon className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{d.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* The theme's tokens, so the shared storefront components resolve
                  var(--radius)/var(--brand) to the same values they will on the
                  live store rather than to nothing. min-h-0 is load-bearing —
                  without it a flex child won't shrink below its content size,
                  and the iframe's flex-1 below would never actually take
                  effect. */}
              <div
                className="mx-auto flex w-full min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-ink-100 bg-white shadow-sm transition-[max-width] duration-200"
                style={{
                  ...tokenStyle(storeTokens(theme, plan.brandColors)),
                  maxWidth: DEVICES.find((d) => d.type === device)?.maxWidth ?? undefined,
                }}
              >
                <div className="flex shrink-0 items-center gap-1.5 border-b border-ink-100 bg-ink-50 px-3 py-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-ink-200" />
                  <span className="h-2.5 w-2.5 rounded-full bg-ink-200" />
                  <span className="h-2.5 w-2.5 rounded-full bg-ink-200" />
                  <span className="ml-2 truncate text-xs text-ink-400">{name || plan.storeName}</span>
                </div>

                {/* The real storefront's own component tree — nav, cart, real
                    per-category sections, spotlight, footer — fed from the
                    builder's live state, so this is what the store actually
                    looks like at launch, not a separate hand-rolled mockup.
                    It renders inside builder-preview-frame's own <iframe>,
                    not directly in this document, so the Mobile/Tablet
                    toggle above gives it a genuinely narrower viewport
                    instead of just a letterboxed div (see that file for
                    why). Links are inert and the cart/newsletter are
                    local-only (previewMode) inside the frame, since there's
                    no launched store to buy from or subscribe to yet. */}
                <iframe
                  ref={previewFrameRef}
                  src="/builder-preview-frame"
                  title="Store preview"
                  className="block w-full flex-1 border-0"
                  onLoad={() => {
                    // A reload (e.g. HMR) resets the frame's own ready state;
                    // its mount effect re-announces "ready" on its own, which
                    // re-triggers the send in the effect above.
                    previewFrameReady.current = false;
                  }}
                />
              </div>
            </div>
          ) : null}
        </div>

        <div className="border-t border-ink-100 bg-white p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Store name" aria-label="Store name" disabled={!plan} className="h-9 w-36 rounded-lg border border-ink-200 px-3 text-sm outline-none focus:border-brand-400 disabled:opacity-50" />
            {/* Selling path is fixed once a store exists — switching it after
                provisioning would orphan the Shopify store it's tied to. */}
            {editing ? (
              <span className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-ink-50 px-2.5 py-1.5 text-xs font-semibold text-ink-600">
                {(() => {
                  const p = PATHS.find((x) => x.type === type);
                  const Icon = p?.icon ?? Store;
                  return (
                    <>
                      <Icon className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">{p?.label ?? PATH_LABELS[type] ?? type}</span>
                    </>
                  );
                })()}
              </span>
            ) : (
              <div className="flex items-center gap-1 rounded-lg border border-ink-200 p-0.5">
                {PATHS.map((p) => (
                  <button key={p.type} type="button" onClick={() => setType(p.type)} disabled={!plan} title={p.label} className={cn("inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition disabled:opacity-50", type === p.type ? "bg-ink-950 text-white" : "text-ink-600 hover:bg-ink-100")}>
                    <p.icon className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{p.label}</span>
                  </button>
                ))}
              </div>
            )}
            {editing ? (
              <div className="ml-auto flex items-center gap-2">
                {existing && plan && (
                  <button
                    onClick={() => setEditingContent((v) => !v)}
                    className={cn(
                      "inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition",
                      editingContent
                        ? "border-brand-500 bg-brand-50 text-brand-700"
                        : "border-ink-200 text-ink-700 hover:bg-ink-50",
                    )}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    {editingContent ? "Preview" : "Content"}
                  </button>
                )}
                {existing && (
                  <VersionHistory
                    storeId={existing.id}
                    onRestored={(note) => {
                      pushAi(note);
                      router.refresh();
                    }}
                  />
                )}
                {existing?.liveUrl && (
                  <a
                    href={existing.liveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-ink-200 px-3 text-sm font-semibold text-ink-700 hover:bg-ink-50"
                  >
                    View live <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                <button onClick={save} disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-500 px-4 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : savedAt ? <><Check className="h-4 w-4" /> Saved</> : "Save changes"}
                </button>
              </div>
            ) : (
              <div className="ml-auto flex items-center gap-2">
                {/* Both need a store id to upload against, so they appear once
                    the draft exists rather than only after Launch. */}
                {plan && draftId && (
                  <button
                    onClick={() => setEditingContent((v) => !v)}
                    className={cn(
                      "inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition",
                      editingContent
                        ? "border-brand-500 bg-brand-50 text-brand-700"
                        : "border-ink-200 text-ink-700 hover:bg-ink-50",
                    )}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    {editingContent ? "Preview" : "Content"}
                  </button>
                )}
                {draftId && (
                  <button
                    onClick={discard}
                    disabled={discarding || saving}
                    title="Delete this draft and start over"
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-ink-200 px-3 text-sm font-semibold text-ink-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  >
                    {discarding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    <span className="hidden sm:inline">Discard</span>
                  </button>
                )}
                <button onClick={create} disabled={!plan || saving} className="inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-brand-500 px-4 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <><ShoppingBag className="h-4 w-4" /> <span className="whitespace-nowrap">Launch my store</span></>}
                </button>
              </div>
            )}
          </div>
          {!editing && draftId && (
            <p className="mt-2 text-xs text-ink-400">
              Saved as a draft — not public, and it doesn&apos;t count against your plan until you launch.
            </p>
          )}
          {!editing && !canCreateStore && plan && <p className="mt-2 text-xs text-amber-600">Store limit reached — upgrade in Billing to create more.</p>}
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
      </div>
      {upgradeMsg && <UpgradeModal message={upgradeMsg} onClose={() => setUpgradeMsg(null)} />}
    </div>
  );
}

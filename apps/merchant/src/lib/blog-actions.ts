"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@ecomstrait/auth/server";
import type { PostStatus, PostSource } from "@ecomstrait/db";
import { assertTokenBudget, recordTokenUsage } from "@/lib/entitlements";
import { generateBlogDraft, type BlogContext } from "@/lib/ecomai";
import { normalizePlan } from "@/lib/store-plan";

/**
 * Blog post authoring — both halves of "AI writes the content, merchant can
 * also just write it themselves." Every action here is owner-scoped through
 * the RLS-bound `createClient()`, mirroring `domain-actions.ts`/
 * `builder-actions.ts`: no admin client, no explicit `user_id` checks needed
 * beyond what RLS already enforces on `store_posts`.
 */

export type Post = {
  id: string;
  storeId: string;
  title: string;
  slug: string;
  excerpt: string | null;
  body: string;
  coverImage: string | null;
  status: PostStatus;
  source: PostSource;
  seoTitle: string | null;
  seoDescription: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type PostRow = {
  id: string;
  store_id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  body: string;
  cover_image: string | null;
  status: PostStatus;
  source: PostSource;
  seo_title: string | null;
  seo_description: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

function mapRow(r: PostRow): Post {
  return {
    id: r.id,
    storeId: r.store_id,
    title: r.title,
    slug: r.slug,
    excerpt: r.excerpt,
    body: r.body,
    coverImage: r.cover_image,
    status: r.status,
    source: r.source,
    seoTitle: r.seo_title,
    seoDescription: r.seo_description,
    publishedAt: r.published_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

type OwnStoreResult =
  | { ok: false; error: string }
  | { ok: true; supabase: SupabaseServerClient; store: { id: string; name: string | null; content: unknown } };

async function ownStore(storeId: string): Promise<OwnStoreResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  const { data: store } = await supabase
    .from("stores")
    .select("id, name, content")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!store) return { ok: false, error: "Store not found." };
  return { ok: true, supabase, store };
}

/**
 * The real facts the blog writer gets to work from — the plan's about/
 * tagline/collections, the store's listed products (same two-step
 * `store_products` → `products` pattern as `storefront.ts`), and the titles
 * already posted so the draft doesn't repeat one. Any part that fails to
 * load is simply omitted; the draft still generates from the rest
 * (2026-09-07 capability audit, T6/§5.1/§5.5).
 */
async function blogContextFor(
  supabase: SupabaseServerClient,
  store: { id: string; name: string | null; content: unknown },
): Promise<BlogContext> {
  const plan = normalizePlan(store.content, store.name ?? "the store");
  const context: BlogContext = {
    about: plan.about || null,
    tagline: plan.tagline || null,
    collections: plan.collections,
  };

  const [{ data: listings }, { data: posts }] = await Promise.all([
    supabase.from("store_products").select("product_id").eq("store_id", store.id).eq("status", "approved"),
    supabase.from("store_posts").select("title").eq("store_id", store.id).order("created_at", { ascending: false }).limit(20),
  ]);

  const ids = (listings ?? []).map((r) => r.product_id);
  if (ids.length) {
    const { data: products } = await supabase
      .from("products")
      .select("title, category")
      .in("id", ids)
      .eq("status", "published")
      .limit(30);
    context.products = (products ?? []).map((p) => ({ title: p.title, category: p.category }));
  }
  context.existingPostTitles = (posts ?? []).map((p) => p.title);
  return context;
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "post"
  );
}

/** Appends -2, -3, ... until the slug doesn't collide with another post on this store. */
async function uniqueSlug(
  supabase: SupabaseServerClient,
  storeId: string,
  base: string,
  excludeId?: string,
): Promise<string> {
  let slug = base;
  for (let n = 2; ; n++) {
    let query = supabase.from("store_posts").select("id").eq("store_id", storeId).eq("slug", slug);
    if (excludeId) query = query.neq("id", excludeId);
    const { data } = await query.maybeSingle();
    if (!data) return slug;
    slug = `${base}-${n}`;
  }
}

/** Every post on a store, newest first — the authoring list. */
export async function listPosts(storeId: string): Promise<Post[]> {
  const s = await ownStore(storeId);
  if (!s.ok) return [];
  const { data } = await s.supabase
    .from("store_posts")
    .select("*")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false });
  return (data ?? []).map(mapRow);
}

export async function getPost(storeId: string, postId: string): Promise<Post | null> {
  const s = await ownStore(storeId);
  if (!s.ok) return null;
  const { data } = await s.supabase
    .from("store_posts")
    .select("*")
    .eq("store_id", storeId)
    .eq("id", postId)
    .maybeSingle();
  return data ? mapRow(data) : null;
}

/** A blank post the merchant writes from scratch. */
export async function createPost(storeId: string, title: string): Promise<{ post?: Post; error?: string }> {
  const s = await ownStore(storeId);
  if (!s.ok) return { error: s.error };

  const cleanTitle = title.trim() || "Untitled post";
  const slug = await uniqueSlug(s.supabase, storeId, slugify(cleanTitle));
  const { data, error } = await s.supabase
    .from("store_posts")
    .insert({ store_id: storeId, title: cleanTitle, slug, source: "merchant" })
    .select("*")
    .single();
  if (error || !data) return { error: error?.message ?? "Could not create the post." };

  revalidatePath(`/stores/${storeId}/blog`);
  return { post: mapRow(data) };
}

/** An AI-drafted post from a topic — the merchant still reviews and edits before publishing. */
export async function generatePostDraft(
  storeId: string,
  topic: string,
): Promise<{ post?: Post; error?: string; upgrade?: boolean }> {
  const s = await ownStore(storeId);
  if (!s.ok) return { error: s.error };
  if (topic.trim().length < 2) return { error: "Tell me what the post should be about." };

  // Sized to the writer's own maxTokens (a 600-900 word body, ~2000 tokens).
  const budget = await assertTokenBudget(2000);
  if (!budget.ok) return { error: budget.error, upgrade: true };

  const context = await blogContextFor(s.supabase, s.store);
  const { draft, tokensUsed } = await generateBlogDraft(topic, s.store.name ?? "the store", context);
  await recordTokenUsage(tokensUsed);

  const slug = await uniqueSlug(s.supabase, storeId, slugify(draft.title));
  const { data, error } = await s.supabase
    .from("store_posts")
    .insert({
      store_id: storeId,
      title: draft.title,
      slug,
      excerpt: draft.excerpt,
      body: draft.body,
      seo_title: draft.seoTitle,
      seo_description: draft.seoDescription,
      source: "ai",
    })
    .select("*")
    .single();
  if (error || !data) return { error: error?.message ?? "Could not save the draft." };

  revalidatePath(`/stores/${storeId}/blog`);
  return { post: mapRow(data) };
}

/** Save edits — the merchant's own writing, or their touch-ups on an AI draft. Doesn't change `source`. */
export async function updatePost(
  storeId: string,
  postId: string,
  input: {
    title: string;
    slug: string;
    excerpt: string;
    body: string;
    coverImage: string | null;
    seoTitle: string;
    seoDescription: string;
  },
): Promise<{ post?: Post; error?: string }> {
  const s = await ownStore(storeId);
  if (!s.ok) return { error: s.error };

  const title = input.title.trim() || "Untitled post";
  const slug = await uniqueSlug(s.supabase, storeId, slugify(input.slug.trim() || title), postId);

  const { data, error } = await s.supabase
    .from("store_posts")
    .update({
      title,
      slug,
      excerpt: input.excerpt.trim() || null,
      body: input.body,
      cover_image: input.coverImage,
      seo_title: input.seoTitle.trim() || null,
      seo_description: input.seoDescription.trim() || null,
    })
    .eq("id", postId)
    .eq("store_id", storeId)
    .select("*")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "Post not found." };

  revalidatePath(`/stores/${storeId}/blog`);
  revalidatePath(`/store/${storeId}/blog/${slug}`);
  return { post: mapRow(data) };
}

/**
 * Publish or unpublish. `published_at` is set once, on the first publish,
 * and never touched again — an unpublish/republish cycle (or an edit
 * afterward) must not make a post look newer than it is.
 */
export async function setPostStatus(
  storeId: string,
  postId: string,
  status: PostStatus,
): Promise<{ post?: Post; error?: string }> {
  const s = await ownStore(storeId);
  if (!s.ok) return { error: s.error };

  const { data: current } = await s.supabase
    .from("store_posts")
    .select("published_at")
    .eq("id", postId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (!current) return { error: "Post not found." };

  const fields: { status: PostStatus; published_at?: string } = { status };
  if (status === "published" && !current.published_at) fields.published_at = new Date().toISOString();

  const { data, error } = await s.supabase
    .from("store_posts")
    .update(fields)
    .eq("id", postId)
    .eq("store_id", storeId)
    .select("*")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "Post not found." };

  revalidatePath(`/stores/${storeId}/blog`);
  revalidatePath(`/store/${storeId}/blog`);
  return { post: mapRow(data) };
}

export async function deletePost(storeId: string, postId: string): Promise<{ ok?: true; error?: string }> {
  const s = await ownStore(storeId);
  if (!s.ok) return { error: s.error };
  const { error } = await s.supabase.from("store_posts").delete().eq("id", postId).eq("store_id", storeId);
  if (error) return { error: error.message };

  revalidatePath(`/stores/${storeId}/blog`);
  return { ok: true };
}

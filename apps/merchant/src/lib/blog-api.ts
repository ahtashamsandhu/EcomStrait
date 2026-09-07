import "server-only";

import { createAdminClient } from "@ecomstrait/db/admin";

/** Public reads of a store's blog — published posts only, service-role (no auth), same pattern as storefront-api.ts. */

export type PostSummary = {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  coverImage: string | null;
  publishedAt: string;
};

export type PostDetail = PostSummary & {
  body: string;
  seoTitle: string | null;
  seoDescription: string | null;
};

/** Every published post on a store, newest first. */
export async function listPublishedPosts(storeId: string): Promise<PostSummary[]> {
  const admin = createAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("store_posts")
    .select("id, title, slug, excerpt, cover_image, published_at")
    .eq("store_id", storeId)
    .eq("status", "published")
    .order("published_at", { ascending: false });
  // Supabase resolves with `{ error }` rather than throwing on a failed
  // query — an empty list is the right fallback either way (no posts, or a
  // real failure), but a real failure deserves a log, not silent identical
  // behavior to "this store just has no posts."
  if (error) console.error("[blog-api] could not list posts:", error.message);
  return (data ?? [])
    .filter((p): p is typeof p & { published_at: string } => p.published_at != null)
    .map((p) => ({ id: p.id, title: p.title, slug: p.slug, excerpt: p.excerpt, coverImage: p.cover_image, publishedAt: p.published_at }));
}

/**
 * Every published post on a store, full body included — for the Store
 * Builder's live preview, same reasoning as `listStorePagesWithBody`
 * (pages-api.ts): that preview has no server round-trip per click, so
 * whatever it might open has to already be in hand.
 */
export async function listPublishedPostsWithBody(storeId: string): Promise<PostDetail[]> {
  const admin = createAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("store_posts")
    .select("id, title, slug, excerpt, body, cover_image, seo_title, seo_description, published_at")
    .eq("store_id", storeId)
    .eq("status", "published")
    .order("published_at", { ascending: false });
  if (error) console.error("[blog-api] could not list posts with body:", error.message);
  return (data ?? [])
    .filter((p): p is typeof p & { published_at: string } => p.published_at != null)
    .map((p) => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      excerpt: p.excerpt,
      coverImage: p.cover_image,
      publishedAt: p.published_at,
      body: p.body,
      seoTitle: p.seo_title,
      seoDescription: p.seo_description,
    }));
}

/** A single published post by slug, or null if it doesn't exist or isn't published. */
export async function getPublishedPost(storeId: string, slug: string): Promise<PostDetail | null> {
  const admin = createAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("store_posts")
    .select("id, title, slug, excerpt, body, cover_image, seo_title, seo_description, published_at")
    .eq("store_id", storeId)
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle();
  if (error) console.error("[blog-api] could not read post:", error.message);
  if (!data || !data.published_at) return null;
  return {
    id: data.id,
    title: data.title,
    slug: data.slug,
    excerpt: data.excerpt,
    coverImage: data.cover_image,
    publishedAt: data.published_at,
    body: data.body,
    seoTitle: data.seo_title,
    seoDescription: data.seo_description,
  };
}

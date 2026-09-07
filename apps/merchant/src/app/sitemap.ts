import "server-only";

import type { MetadataRoute } from "next";
import { createAdminClient } from "@ecomstrait/db/admin";
import { siteUrl } from "@/lib/site-url";
import { isPublicStatus } from "@/lib/store-status";
import { listStoreCategories, listStoreProducts } from "@/lib/storefront-api";
import { listPublishedPosts } from "@/lib/blog-api";
import { listStorePages } from "@/lib/pages-api";

// Otherwise Next prerenders this once at build time — a store launched (or a
// product added) afterward would stay invisible to crawlers until the next
// deploy, silently.
export const dynamic = "force-dynamic";

/**
 * One sitemap for every own-platform store reachable at the shared
 * `/store/<uuid>` path.
 *
 * A store with a *verified* connected domain is deliberately excluded here
 * — it gets its own sitemap at its own domain instead (see
 * store/by-domain/[domain]/sitemap.xml/route.ts). Listing the same store
 * under two hosts would split its canonical signal between them; each store
 * belongs on exactly one sitemap.
 *
 * Bounded to the first 60 products per store (matching `listStoreProducts`'
 * page-size cap) — fine at today's catalog sizes, but a store that outgrows
 * that will have older products missing from its sitemap until this
 * paginates properly.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const admin = createAdminClient();
  if (!admin) return [];

  const { data: stores } = await admin
    .from("stores")
    .select("id, status, type, domain, domain_verified_at, updated_at")
    .eq("type", "own_platform");

  const base = siteUrl();
  const entries: MetadataRoute.Sitemap = [];

  for (const store of stores ?? []) {
    if (!isPublicStatus(store.status)) continue;
    if (store.domain && store.domain_verified_at) continue;

    const url = `${base}/store/${store.id}`;
    entries.push({ url, lastModified: store.updated_at, changeFrequency: "weekly", priority: 0.8 });
    entries.push({ url: `${url}/products`, lastModified: store.updated_at, changeFrequency: "daily", priority: 0.6 });

    const categories = await listStoreCategories(store.id);
    for (const c of categories) {
      entries.push({
        url: `${url}/products?category=${encodeURIComponent(c.category)}`,
        lastModified: store.updated_at,
        changeFrequency: "weekly",
        priority: 0.5,
      });
    }

    const { products } = await listStoreProducts(store.id, { limit: 60 });
    for (const p of products) {
      entries.push({ url: `${url}/products/${p.id}`, changeFrequency: "weekly", priority: 0.5 });
    }

    const posts = await listPublishedPosts(store.id);
    if (posts.length) {
      entries.push({ url: `${url}/blog`, lastModified: store.updated_at, changeFrequency: "weekly", priority: 0.5 });
      for (const p of posts) {
        entries.push({ url: `${url}/blog/${p.slug}`, lastModified: p.publishedAt, changeFrequency: "monthly", priority: 0.4 });
      }
    }

    const pages = await listStorePages(store.id);
    for (const p of pages) {
      entries.push({ url: `${url}/${p.slug}`, lastModified: store.updated_at, changeFrequency: "monthly", priority: 0.4 });
    }
  }

  return entries;
}

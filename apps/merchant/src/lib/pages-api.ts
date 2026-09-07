import "server-only";

import { createAdminClient } from "@ecomstrait/db/admin";

/** Public reads of a store's custom pages — created via the EcomAI chat (see applyPageAction in builder-actions.ts). */

export type PageSummary = { slug: string; title: string };
export type PageDetail = PageSummary & { body: string };

/** Every page on a store, for the nav — no status/visibility gate, a page exists the moment chat creates it. */
export async function listStorePages(storeId: string): Promise<PageSummary[]> {
  const admin = createAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("store_pages")
    .select("slug, title")
    .eq("store_id", storeId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[pages-api] could not list pages:", error.message);
    return [];
  }
  return data ?? [];
}

/**
 * Every page on a store, full body included — for the Store Builder's live
 * preview, which (unlike the real storefront's own nav) has nowhere else to
 * fetch a page's content from: the whole point of that preview is showing
 * live, unsaved edits with no server round-trip per click. `listStorePages`
 * stays body-less on purpose for the real nav — that one gets fetched on
 * every single storefront page load, and no page there needs more than its
 * slug/title until someone actually opens it.
 */
export async function listStorePagesWithBody(storeId: string): Promise<PageDetail[]> {
  const admin = createAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("store_pages")
    .select("slug, title, body")
    .eq("store_id", storeId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[pages-api] could not list pages with body:", error.message);
    return [];
  }
  return data ?? [];
}

/** A single page by slug, or null if it doesn't exist on this store. */
export async function getStorePage(storeId: string, slug: string): Promise<PageDetail | null> {
  const admin = createAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("store_pages")
    .select("slug, title, body")
    .eq("store_id", storeId)
    .eq("slug", slug)
    .maybeSingle();
  if (error) {
    console.error("[pages-api] could not read page:", error.message);
    return null;
  }
  return data ?? null;
}

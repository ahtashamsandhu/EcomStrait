import "server-only";
import { createAdminClient } from "@ecomstrait/db/admin";
import { deleteFromProvider } from "@/lib/media";
import { DRAFT_TTL_DAYS } from "@/lib/store-status";

/**
 * Expiring abandoned draft stores.
 *
 * A draft is created as soon as EcomAI produces a plan, so most of them are
 * attempts the merchant walked away from. Left alone they would accumulate
 * forever, and — because the media library attaches to a store id — each one
 * can be holding uploaded images and video in R2.
 *
 * Deleting the row cascades to `store_products`, `store_theme_versions` and
 * `store_assets`, but nothing cascades to object storage. So the bytes go
 * first, then the rows: a stranded object costs money quietly, whereas a
 * `store_assets` row pointing at a deleted file breaks the library visibly.
 */

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

/**
 * Delete the uploaded bytes belonging to a set of stores.
 *
 * Best-effort by design: a provider that's down must not stop the merchant's
 * store from being removed. Supabase-hosted files are removed in one call;
 * R2 objects go one at a time, which is all its delete API offers here.
 */
export async function purgeStoreMedia(admin: Admin, storeIds: string[]): Promise<void> {
  if (!storeIds.length) return;

  const { data: assets } = await admin
    .from("store_assets")
    .select("provider, external_id")
    .in("store_id", storeIds);
  if (!assets?.length) return;

  const supabasePaths = assets
    .filter((a) => a.provider === "supabase" && a.external_id)
    .map((a) => a.external_id as string);
  if (supabasePaths.length) {
    try {
      await admin.storage.from("store-assets").remove(supabasePaths);
    } catch {
      // Stranded bytes are untidy; blocking the delete is worse.
    }
  }

  for (const a of assets) {
    if (a.provider !== "supabase") await deleteFromProvider(a.provider, a.external_id);
  }
}

export type SweepResult = { deleted: number; error?: string };

/**
 * Delete drafts untouched for longer than the TTL.
 *
 * `userId` narrows the sweep to one merchant, which is what the builder does on
 * entry so that expiry works even where no scheduler is configured. The cron
 * route omits it and sweeps everyone.
 *
 * Needs the service role: the sweep runs for users who aren't the caller, and
 * on a schedule where there's no session at all.
 */
export async function sweepExpiredDrafts(
  opts: { userId?: string; limit?: number } = {},
): Promise<SweepResult> {
  const admin = createAdminClient();
  if (!admin) return { deleted: 0, error: "Service role key not configured." };

  const cutoff = new Date(Date.now() - DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // `launched_at is null` is what makes this safe: a launched Shopify store is
  // also status 'draft' until it's provisioned, and sweeping those would delete
  // stores merchants have paid for and are waiting on.
  let q = admin
    .from("stores")
    .select("id")
    .eq("status", "draft")
    .is("launched_at", null)
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(opts.limit ?? 500);
  if (opts.userId) q = q.eq("user_id", opts.userId);

  const { data: expired, error } = await q;
  if (error) return { deleted: 0, error: error.message };

  const ids = (expired ?? []).map((s) => s.id);
  if (!ids.length) return { deleted: 0 };

  await purgeStoreMedia(admin, ids);

  // Re-assert the condition in the delete itself. The read and the write aren't
  // a transaction, so a draft launched in between must survive — matching on
  // `launched_at is null` makes that a database-level condition, not a hope.
  const { error: delErr, count } = await admin
    .from("stores")
    .delete({ count: "exact" })
    .in("id", ids)
    .eq("status", "draft")
    .is("launched_at", null);
  if (delErr) return { deleted: 0, error: delErr.message };

  return { deleted: count ?? 0 };
}

import "server-only";
import { createAdminClient } from "@ecomstrait/db/admin";

/**
 * Read-through cache for a business snapshot (revenue/order aggregation is
 * real work, and the Co-Founder chat used to recompute it on every single
 * message). TTL-checked, not forever-cached like `store_category_content` —
 * this data changes constantly, so staleness is "older than `ttlMs`," not
 * "a row already exists."
 *
 * Fails open at every step: no DB configured, a read error, or a write
 * error all fall through to (or don't block) a live `compute()` — a broken
 * cache must never be why the co-founder can't answer.
 */
export async function getOrComputeSnapshot<T>(
  subjectType: "merchant" | "supplier",
  subjectId: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const client = createAdminClient();
  if (!client) return compute();

  try {
    const { data, error } = await client
      .from("ai_snapshot_cache")
      .select("snapshot_json, computed_at")
      .eq("subject_type", subjectType)
      .eq("subject_id", subjectId)
      .maybeSingle();
    if (error) {
      console.error("[ai] snapshot cache read failed, computing live:", error.message);
    } else if (data && Date.now() - new Date(data.computed_at).getTime() < ttlMs) {
      return data.snapshot_json as T;
    }
  } catch (err) {
    console.error("[ai] snapshot cache read threw, computing live:", err);
  }

  const fresh = await compute();

  try {
    const { error } = await client.from("ai_snapshot_cache").upsert(
      {
        subject_type: subjectType,
        subject_id: subjectId,
        snapshot_json: fresh as Record<string, unknown>,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "subject_type,subject_id" },
    );
    if (error) console.error("[ai] failed to cache snapshot (non-fatal):", error.message);
  } catch (err) {
    console.error("[ai] snapshot cache write threw (non-fatal):", err);
  }

  return fresh;
}

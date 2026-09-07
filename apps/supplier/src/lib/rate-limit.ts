import "server-only";
import { createAdminClient } from "@ecomstrait/db/admin";

export type RateLimit = { limit: number; windowSeconds: number };
export type RateLimitResult = { allowed: boolean; hits: number; resetAt: Date | null };

/**
 * Fixed-window counter backed by `bump_rate_limit` (service-role only).
 * Fails open: if the database can't be reached the request is allowed and
 * the failure logged — a rate limiter must never be the thing that takes
 * the app down.
 */
export async function rateLimit(bucket: string, opts: RateLimit): Promise<RateLimitResult> {
  const admin = createAdminClient();
  if (!admin) return { allowed: true, hits: 0, resetAt: null };
  const client = admin as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{
      data: { hits: number; allowed: boolean; reset_at: string }[] | null;
      error: { message: string } | null;
    }>;
  };
  try {
    const { data, error } = await client.rpc("bump_rate_limit", {
      p_bucket: bucket.slice(0, 200),
      p_window_seconds: opts.windowSeconds,
      p_limit: opts.limit,
    });
    if (error || !data?.length) {
      if (error) console.error("[rate-limit] rpc failed, allowing request:", error.message);
      return { allowed: true, hits: 0, resetAt: null };
    }
    const row = data[0];
    return { allowed: row.allowed, hits: row.hits, resetAt: new Date(row.reset_at) };
  } catch (e) {
    console.error("[rate-limit] unavailable, allowing request:", e);
    return { allowed: true, hits: 0, resetAt: null };
  }
}

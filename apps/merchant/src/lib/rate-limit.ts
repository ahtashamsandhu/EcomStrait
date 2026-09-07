import { NextResponse } from "next/server";
import { createAdminClient } from "@ecomstrait/db/admin";

/**
 * Fixed-window rate limiting for the public storefront API.
 *
 * The counter lives in Postgres so it's shared across serverless instances —
 * an in-process map would reset on every cold start. One RPC per request,
 * incremented atomically.
 */

export type RateLimit = { limit: number; windowSeconds: number };

/** Cart mutations are chatty by nature; checkout should never be. */
export const CART_LIMIT: RateLimit = { limit: 60, windowSeconds: 60 };
export const CHECKOUT_LIMIT: RateLimit = { limit: 10, windowSeconds: 60 };
export const NEWSLETTER_LIMIT: RateLimit = { limit: 5, windowSeconds: 60 };

export type RateLimitResult = { allowed: boolean; hits: number; resetAt: Date | null };

/**
 * Best-effort caller identity. Vercel sets `x-forwarded-for`; the first entry is
 * the client. Everything behind that is proxy chain and can be spoofed, so it's
 * deliberately ignored.
 */
export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim();
  return ip || "unknown";
}

/**
 * Count a hit. Fails OPEN: if the limiter itself is unavailable the storefront
 * keeps working — an outage here must not take down checkout.
 */
export async function rateLimit(bucket: string, opts: RateLimit): Promise<RateLimitResult> {
  const admin = createAdminClient();
  if (!admin) return { allowed: true, hits: 0, resetAt: null };

  // `bump_rate_limit` isn't in the generated Database types (Functions is
  // empty), so the client is widened for this call. Note it stays a METHOD
  // call — pulling `admin.rpc` into a variable loses its `this` binding.
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
    if (error) {
      console.error("[rate-limit] rpc failed, allowing request:", error.message);
      return { allowed: true, hits: 0, resetAt: null };
    }
    if (!data?.length) return { allowed: true, hits: 0, resetAt: null };

    const row = data[0];
    return { allowed: row.allowed, hits: row.hits, resetAt: new Date(row.reset_at) };
  } catch (e) {
    console.error("[rate-limit] unavailable, allowing request:", e);
    return { allowed: true, hits: 0, resetAt: null };
  }
}

/** Standard 429 with Retry-After, so clients can back off properly. */
export function tooManyRequests(result: RateLimitResult) {
  const seconds = result.resetAt
    ? Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000))
    : 60;
  return NextResponse.json(
    { error: "Too many requests — slow down and try again shortly." },
    {
      status: 429,
      headers: { "Retry-After": String(seconds), "Cache-Control": "no-store" },
    },
  );
}

/**
 * Guard a storefront route. Returns a 429 response to return early, or null to
 * carry on.
 */
export async function guard(
  req: Request,
  scope: string,
  storeId: string,
  opts: RateLimit,
): Promise<NextResponse | null> {
  const result = await rateLimit(`${scope}:${storeId}:${clientKey(req)}`, opts);
  return result.allowed ? null : tooManyRequests(result);
}

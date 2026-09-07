import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of a caller-supplied secret against the expected
 * one. `a !== b` short-circuits on the first differing byte, which leaks how
 * many leading bytes matched to anyone who can time the request precisely.
 *
 * Returns false when either side is missing, so an unset env var can never
 * accidentally match an empty header.
 */
export function secretMatches(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Reads `Authorization: Bearer <token>` and compares it constant-time. */
export function bearerMatches(req: Request, expected: string | null | undefined): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return secretMatches(token, expected);
}

const INTERNAL_MAX_SKEW_SECONDS = 300;

/**
 * Authenticate a call from the supplier app to /api/internal/*.
 *
 * Three checks, all required: the shared secret header, a timestamp within
 * five minutes of now, and an HMAC-SHA256 signature over
 * `<timestamp>.<raw body>` with that secret. The signature is what stops a
 * captured request being replayed or its body altered; the timestamp bounds
 * how long a capture is useful. `ECOMSTRAIT_INTERNAL_SECRET` lets this
 * channel use its own secret, separate from the Shopify app's.
 */
export function verifyInternalRequest(req: Request, rawBody: string): boolean {
  const secret = process.env.ECOMSTRAIT_INTERNAL_SECRET || process.env.SHOPIFY_APP_SHARED_SECRET;
  if (!secretMatches(req.headers.get("x-ecomstrait-secret"), secret)) return false;
  const timestamp = req.headers.get("x-ecomstrait-timestamp") ?? "";
  const signature = req.headers.get("x-ecomstrait-signature") ?? "";
  if (!/^\d{9,11}$/.test(timestamp) || !signature) return false;
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (skew > INTERNAL_MAX_SKEW_SECONDS) return false;
  const expected = createHmac("sha256", secret!).update(`${timestamp}.${rawBody}`).digest("hex");
  return secretMatches(signature, expected);
}

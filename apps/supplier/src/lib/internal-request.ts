import "server-only";
import crypto from "node:crypto";

/**
 * Headers for a call from this app to the merchant app's /api/internal/*.
 *
 * Besides the shared secret, the body is signed: HMAC-SHA256 over
 * `<unix seconds>.<body>`. The merchant side rejects anything older than
 * five minutes or with a signature that doesn't match, so a captured request
 * can't be replayed later and a body can't be altered in transit.
 */
export function signedInternalHeaders(body: string): Record<string, string> | null {
  const secret = process.env.ECOMSTRAIT_SHARED_SECRET;
  if (!secret) return null;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return {
    "Content-Type": "application/json",
    "x-ecomstrait-secret": secret,
    "x-ecomstrait-timestamp": timestamp,
    "x-ecomstrait-signature": signature,
  };
}

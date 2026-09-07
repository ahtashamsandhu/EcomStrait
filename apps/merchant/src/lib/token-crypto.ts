import "server-only";
import crypto from "node:crypto";

/**
 * At-rest encryption for Shopify Admin API tokens (`shopify_stores.access_token`).
 *
 * AES-256-GCM with a random 96-bit IV, keyed by `SHOPIFY_TOKEN_KEY` (32 bytes,
 * hex or base64). Stored form: `enc:v1:<base64(iv | tag | ciphertext)>`.
 *
 * Reads tolerate legacy plaintext rows (no prefix) so nothing breaks while
 * existing rows are re-sealed (`scripts/reseal-shopify-tokens.mjs`). Without
 * a key, writes stay plaintext and a sealed value can't be opened — that is
 * logged loudly rather than silently returning the ciphertext as a token.
 */
const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";

function loadKey(): Buffer | null {
  const raw = process.env.SHOPIFY_TOKEN_KEY?.trim();
  if (!raw) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    console.error("[token-crypto] SHOPIFY_TOKEN_KEY must decode to 32 bytes; tokens will not be encrypted.");
    return null;
  }
  return buf;
}

export function isSealed(value: string | null | undefined): boolean {
  return Boolean(value?.startsWith(PREFIX));
}

/** Encrypt a token for storage. Returns the input unchanged when no key is configured. */
export function sealToken(plain: string): string {
  const key = loadKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Decrypt a stored token. Plaintext legacy values pass through; an unopenable sealed value yields null. */
export function openToken(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith(PREFIX)) return stored;
  const key = loadKey();
  if (!key) {
    console.error("[token-crypto] sealed token present but SHOPIFY_TOKEN_KEY is not set.");
    return null;
  }
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (err) {
    console.error("[token-crypto] could not open a sealed token:", err);
    return null;
  }
}

/** Copy of a `shopify_stores` row with its `access_token` opened for use. */
export function withOpenToken<T extends { access_token: string | null }>(row: T | null | undefined): T | null {
  if (!row) return null;
  return { ...row, access_token: openToken(row.access_token) };
}

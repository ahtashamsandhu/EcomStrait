#!/usr/bin/env node
/**
 * One-off: encrypt every plaintext `shopify_stores.access_token` with
 * SHOPIFY_TOKEN_KEY (see src/lib/token-crypto.ts). Idempotent — sealed rows
 * are skipped. Run with the merchant app's env loaded:
 *
 *   node --env-file=.env.local scripts/reseal-shopify-tokens.mjs
 */
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const rawKey = process.env.SHOPIFY_TOKEN_KEY?.trim();
if (!url || !serviceKey || !rawKey) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SHOPIFY_TOKEN_KEY.");
  process.exit(1);
}
const key = /^[0-9a-fA-F]{64}$/.test(rawKey) ? Buffer.from(rawKey, "hex") : Buffer.from(rawKey, "base64");
if (key.length !== 32) {
  console.error("SHOPIFY_TOKEN_KEY must decode to 32 bytes.");
  process.exit(1);
}
const PREFIX = "enc:v1:";
function seal(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const { data: rows, error } = await admin.from("shopify_stores").select("id, access_token").not("access_token", "is", null);
if (error) {
  console.error(error);
  process.exit(1);
}
let sealed = 0;
for (const row of rows ?? []) {
  if (!row.access_token || row.access_token.startsWith(PREFIX)) continue;
  const { error: upErr } = await admin.from("shopify_stores").update({ access_token: seal(row.access_token) }).eq("id", row.id);
  if (upErr) {
    console.error(row.id, upErr.message);
    continue;
  }
  sealed += 1;
}
console.log(`sealed ${sealed} of ${rows?.length ?? 0} tokens`);

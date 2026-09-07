import "server-only";

import { createAdminClient } from "@ecomstrait/db/admin";

/**
 * Storefront newsletter signups, via Resend's Audience/Contacts API — the
 * same Resend account already used for ops alerts (`ops-alert.ts`), just a
 * different part of its API.
 *
 * One Resend Audience per store, created lazily on that store's first
 * subscriber rather than up front for every store — a merchant's list stays
 * theirs to send to, instead of every store's subscribers landing in one
 * shared platform-wide list nobody could actually use.
 */

const API = "https://api.resend.com";

export function isNewsletterConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" };
}

/** Loose but real validation — same bar as everywhere else user-supplied contact info is accepted. */
export function isValidEmail(input: string): boolean {
  const email = input.trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** This store's Resend Audience id, creating one on Resend if it doesn't have one yet. */
async function ensureStoreAudience(storeId: string, storeName: string): Promise<string | null> {
  const admin = createAdminClient();
  if (!admin) return null;

  const { data: store, error: readError } = await admin
    .from("stores")
    .select("newsletter_audience_id")
    .eq("id", storeId)
    .maybeSingle();
  if (readError) {
    console.error("[newsletter] could not read store:", readError.message);
    return null;
  }
  if (store?.newsletter_audience_id) return store.newsletter_audience_id;

  try {
    const res = await fetch(`${API}/audiences`, {
      method: "POST",
      headers: authHeaders(),
      // Resend audience names aren't customer-facing anywhere — this is only
      // ever seen in the Resend dashboard, so the store id is there purely to
      // keep two stores that happen to share a name apart.
      body: JSON.stringify({ name: `${storeName} (${storeId})` }),
    });
    if (!res.ok) {
      console.error(`[newsletter] failed to create audience: Resend returned ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { id?: string };
    if (!body.id) return null;

    const { error: writeError } = await admin
      .from("stores")
      .update({ newsletter_audience_id: body.id })
      .eq("id", storeId);
    if (writeError) console.error("[newsletter] created the audience but failed to save its id:", writeError.message);

    return body.id;
  } catch (e) {
    console.error("[newsletter] could not reach Resend:", e);
    return null;
  }
}

export type SubscribeResult = { ok: boolean; error?: string };

/** Add an email to a store's newsletter audience, creating that audience first if needed. */
export async function subscribeToNewsletter(storeId: string, storeName: string, email: string): Promise<SubscribeResult> {
  if (!isValidEmail(email)) return { ok: false, error: "Enter a valid email address." };
  if (!isNewsletterConfigured()) return { ok: false, error: "Sign-ups aren't available right now." };

  const audienceId = await ensureStoreAudience(storeId, storeName);
  if (!audienceId) return { ok: false, error: "Sign-ups aren't available right now." };

  try {
    const res = await fetch(`${API}/audiences/${audienceId}/contacts`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: email.trim(), unsubscribed: false }),
    });
    if (res.ok) return { ok: true };

    // Resend errors on a contact that's already in the audience — that's the
    // outcome the visitor wanted, not a failure to report back to them.
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    if (/already|exist/i.test(body.message ?? "")) return { ok: true };
    return { ok: false, error: "That didn't go through — try again in a moment." };
  } catch (e) {
    console.error("[newsletter] could not reach Resend:", e);
    return { ok: false, error: "That didn't go through — try again in a moment." };
  }
}

"use server";

import { promises as dns } from "node:dns";
import { revalidatePath } from "next/cache";
import { createClient } from "@ecomstrait/auth/server";
import type { StoreType } from "@ecomstrait/db";
import { createAdminClient } from "@ecomstrait/db/admin";
import { domainTarget, isValidDomain, normalizeDomain } from "@/lib/domain";
import { addProjectDomain, removeProjectDomain } from "@/lib/vercel-domains";

type OwnStore = { id: string; type: StoreType; domain: string | null };

type OwnStoreResult =
  | { ok: false; error: string }
  | { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; store: OwnStore };

/** Load the caller's store (owner-scoped) or return an error. */
async function ownStore(storeId: string): Promise<OwnStoreResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  const { data: store } = await supabase
    .from("stores")
    .select("id, type, domain")
    .eq("id", storeId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!store) return { ok: false, error: "Store not found." };
  return { ok: true, supabase, store };
}

/** Save (or clear) a store's custom domain. */
export async function setStoreDomain(
  storeId: string,
  input: string,
): Promise<{ error?: string; domain?: string | null }> {
  const s = await ownStore(storeId);
  if (!s.ok) return { error: s.error };

  const raw = input.trim();
  // A domain only ever gets attached to our Vercel project for own_platform
  // stores — a Shopify store's DNS instructions point at Shopify's own
  // infrastructure, not ours, so there's nothing of ours to detach/attach.
  const isOwn = s.store.type === "own_platform";
  const previous = s.store.domain;

  if (!raw) {
    // domain_verified_at clears with it — nothing routes to a domain the
    // store no longer claims.
    await s.supabase.from("stores").update({ domain: null, domain_verified_at: null }).eq("id", storeId);
    if (isOwn && previous) void removeProjectDomain(previous);
    revalidatePath("/settings");
    return { domain: null };
  }
  const domain = normalizeDomain(raw);
  if (!isValidDomain(domain)) return { error: "Enter a valid domain, e.g. yourbrand.com" };

  // Changing the domain invalidates any previous verification — traffic for
  // the old value should stop routing the instant the merchant repoints it,
  // not linger until the next DNS check happens to run.
  const { error } = await s.supabase
    .from("stores")
    .update({ domain, domain_verified_at: null })
    .eq("id", storeId);
  if (error) {
    // RLS scopes this client to the caller's own stores, so a SELECT could
    // never see another merchant's row to check for a collision up front —
    // only the DB's unique index (across every store, RLS or not) actually
    // catches that. Translate its constraint-violation error into something
    // a merchant can act on.
    if (error.code === "23505") return { error: "That domain is already connected to another store." };
    return { error: error.message };
  }
  // Best-effort cleanup — a stray domain still attached to the Vercel
  // project isn't something the merchant can see or fix, so it must not
  // block saving the new one.
  if (isOwn && previous && previous !== domain) void removeProjectDomain(previous);
  revalidatePath("/settings");
  return { domain };
}

export type DomainCheck = {
  connected: boolean;
  resolvedA: string[];
  resolvedCname: string[];
  expectedA: string;
  verifiedAt: string | null;
  /** Set only if attaching the domain to Vercel failed after DNS otherwise checked out. */
  vercelError?: string;
};

/**
 * Live DNS lookup: does the domain point at the expected storefront host?
 *
 * A pointed-at-us apex A record is the same proof of control every host in
 * this business relies on (Vercel, Netlify, Shopify all verify custom
 * domains this way) — only whoever controls the domain's DNS zone can make
 * that true. The result is persisted (`domain_verified_at`), because for an
 * `own_platform` store this is also the switch that turns on host-based
 * routing (see `resolveStoreByDomain`): traffic for the domain only serves
 * this store once that column is set, and stops the moment a re-check finds
 * it's no longer pointed at us.
 *
 * For an `own_platform` store, a successful check also attaches the domain
 * to the actual Vercel project (when `VERCEL_TOKEN`/`VERCEL_PROJECT_ID` are
 * set) — DNS pointing at Vercel's IP alone was never enough for Vercel to
 * route traffic or issue SSL for it; the domain has to be registered on the
 * project too. This is what makes the "we provision SSL automatically" line
 * merchants already see here true rather than aspirational.
 */
export async function checkStoreDomain(storeId: string): Promise<DomainCheck | { error: string }> {
  const s = await ownStore(storeId);
  if (!s.ok) return { error: s.error };
  const domain = s.store.domain;
  if (!domain) return { error: "No domain set." };

  const target = domainTarget(s.store.type as StoreType);

  let resolvedA: string[] = [];
  let resolvedCname: string[] = [];
  try {
    resolvedA = await dns.resolve4(domain);
  } catch {
    /* apex may be a CNAME (flattened) or not yet propagated */
  }
  try {
    resolvedCname = await dns.resolveCname(`www.${domain}`);
  } catch {
    /* www may not be set yet */
  }

  const connected = resolvedA.includes(target.expectedA);
  const verifiedAt = connected ? new Date().toISOString() : null;
  // The DNS proof was checked by this server, so the result is written with
  // the service role: a session may only ever clear domain_verified_at (a
  // trigger enforces that), never set it — otherwise a merchant could claim
  // any hostname without owning it.
  const admin = createAdminClient();
  if (admin) {
    // ownStore() above already proved the caller owns this store.
    await admin.from("stores").update({ domain_verified_at: verifiedAt }).eq("id", storeId);
  }
  revalidatePath("/settings");

  let vercelError: string | undefined;
  if (connected && s.store.type === "own_platform") {
    const vercel = await addProjectDomain(domain);
    // DNS is real and routing already works via our own middleware either
    // way — a Vercel-side hiccup shouldn't be reported as "DNS isn't
    // connected", but it does mean SSL/the actual Vercel routing isn't
    // finished, so say so rather than silently claiming full success.
    if (!vercel.ok && vercel.error !== "Vercel isn't configured.") vercelError = vercel.error;
  }

  return { connected, resolvedA, resolvedCname, expectedA: target.expectedA, verifiedAt, ...(vercelError ? { vercelError } : {}) };
}

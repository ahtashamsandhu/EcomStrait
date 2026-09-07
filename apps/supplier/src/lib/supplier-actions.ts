"use server";

import { redirect, RedirectType } from "next/navigation";
import { createClient } from "@ecomstrait/auth/server";
import type { DocumentType } from "@ecomstrait/db/types";
import type { SupplierForm } from "@/lib/onboarding";
import { friendlyError } from "@/lib/errors";

type SavePatch = Partial<SupplierForm> & { onboarding_step?: number };

const TEXT_FIELDS = [
  "business_name", "business_type", "contact_person", "phone", "country", "city", "website",
  "years_in_business", "number_of_products", "manufacturing_type", "description",
  "estimated_inventory_size", "average_lead_time", "min_order_quantity",
] as const;
const LIST_FIELDS = ["product_categories", "shipping_regions"] as const;
const MAX_TEXT = 2000;
const MAX_LIST = 50;

/**
 * Keep only the onboarding fields, with length caps. The TypeScript type on
 * `patch` is not enforced at runtime — a crafted call could otherwise carry
 * `status: "approved"` or `owner_user_id` straight into the upsert (the
 * database now rejects those too, but the app should never send them).
 */
function sanitizePatch(patch: SavePatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!patch || typeof patch !== "object") return out;
  for (const key of TEXT_FIELDS) {
    const v = (patch as Record<string, unknown>)[key];
    if (typeof v === "string") out[key] = v.trim().slice(0, MAX_TEXT);
  }
  for (const key of LIST_FIELDS) {
    const v = (patch as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      out[key] = v.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 120)).slice(0, MAX_LIST);
    }
  }
  if (typeof patch.onboarding_step === "number" && Number.isInteger(patch.onboarding_step)) {
    out.onboarding_step = Math.min(10, Math.max(1, patch.onboarding_step));
  }
  return out;
}

/** Upsert the caller's supplier row with a partial patch. Returns the row id. */
export async function saveSupplier(
  patch: SavePatch,
): Promise<{ id: string } | { error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const { data, error } = await supabase
    .from("suppliers")
    .upsert({ owner_user_id: user.id, ...sanitizePatch(patch) }, { onConflict: "owner_user_id" })
    .select("id")
    .single();

  if (error) return { error: friendlyError(error) };
  return { id: data.id };
}

/** Record (or replace) an uploaded document of a given type. */
export async function recordDocument(input: {
  supplierId: string;
  type: DocumentType;
  storagePath: string;
}): Promise<{ ok: true } | { error: string }> {
  const supabase = await createClient();

  await supabase
    .from("supplier_documents")
    .delete()
    .eq("supplier_id", input.supplierId)
    .eq("type", input.type);

  const { error } = await supabase.from("supplier_documents").insert({
    supplier_id: input.supplierId,
    type: input.type,
    storage_path: input.storagePath,
  });

  return error ? { error: error.message } : { ok: true };
}

/** Finalize onboarding: accept terms, move to review, seed verification. */
export async function submitOnboarding(input: {
  marketingOptIn: boolean;
}): Promise<{ error: string } | never> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not authenticated." };

  const nowIso = new Date().toISOString();

  const { data: supplier, error } = await supabase
    .from("suppliers")
    .update({
      status: "in_review",
      onboarding_step: 5,
      marketing_opt_in: input.marketingOptIn,
      terms_accepted_at: nowIso,
      // Whatever an earlier "return for edits" flagged has now been
      // resubmitted — clear it so it doesn't reappear as if still
      // outstanding if a later review cycle returns the application again
      // for a different reason.
      return_reasons: [],
      return_note: null,
    })
    .eq("owner_user_id", user.id)
    .select("id")
    .single();

  if (error || !supplier) return { error: error?.message ?? "No supplier found." };

  // Level 1 (email) is satisfied by Supabase's confirmed signup.
  await supabase.from("supplier_verification").upsert(
    { supplier_id: supplier.id, email_verified_at: user.email_confirmed_at ?? nowIso },
    { onConflict: "supplier_id" },
  );

  // `redirect()` called from a Server Action defaults to `push`, which would
  // leave the pre-submission /onboarding entry in browser history — pressing
  // Back would restore that entry's already-rendered wizard (client state
  // frozen at whatever step it was on when the route was first fetched,
  // typically step 1), even though the application has since moved past
  // "pending" server-side. `replace` removes that entry instead of leaving
  // it dangling, so Back goes to wherever the supplier actually was before
  // onboarding, not a stale wizard.
  redirect("/dashboard?onboarded=1", RedirectType.replace);
}

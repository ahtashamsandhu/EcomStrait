import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

let cached: SupabaseClient<Database> | null = null;

/**
 * Server-only Supabase client using the **service-role key**. Bypasses RLS —
 * use only in trusted server code (privileged reads, admin tooling, jobs).
 * Never import from client components. Returns null if env is missing.
 */
export function createAdminClient(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!cached) {
    cached = createClient<Database>(url, key, { auth: { persistSession: false } });
  }
  return cached;
}

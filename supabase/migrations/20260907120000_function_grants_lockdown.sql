-- ============================================================================
--  Security hardening 1/4 — function EXECUTE grants.
--
--  20260722110000_grants.sql granted EXECUTE on every function (and every
--  future function) to anon + authenticated. Postgres also grants EXECUTE to
--  PUBLIC on new functions by default. Together that made every SECURITY
--  DEFINER helper callable through PostgREST with the anon key —
--  `wallet_adjust` (free credits) and `match_ai_embeddings` (cross-tenant
--  RAG dump) included.
--
--  This migration flips the default to deny and re-grants only the functions
--  that user sessions legitimately call. Anything added later must be granted
--  explicitly (see the CI note in Docs/Security-Audit-Merchandise-Suppliers.pdf).
-- ============================================================================

-- ---- 1. Stop granting EXECUTE to user roles by default -------------------
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from authenticated;

-- ---- 2. Revoke on everything that already exists --------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
revoke execute on all functions in schema public from authenticated;

-- service_role keeps everything (it bypasses RLS anyway and is server-only).
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant execute on functions to service_role;

-- ---- 3. Re-grant the helpers RLS policies and sessions rely on -----------
-- Used inside RLS policies: must be executable by the invoking role.
grant execute on function public.current_user_role() to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_member(uuid) to anon, authenticated;

-- Called from a supplier session when cancelling a COD order (hardened in 3/4).
grant execute on function public.reverse_cod_deduction(uuid) to authenticated;

-- Trigger functions are invoked by the system, not via RPC, but keep them
-- executable so no trigger ever fails an ACL check for a user session.
grant execute on function public.touch_updated_at() to anon, authenticated;
grant execute on function public.handle_new_user() to anon, authenticated;
grant execute on function public.enforce_listing_decision() to anon, authenticated;
grant execute on function public.enforce_map_price() to anon, authenticated;

-- ---- 4. Explicit, belt-and-braces revokes on the two that leaked ----------
revoke all on function public.wallet_adjust(
  public.wallet_account_type, uuid, numeric, public.wallet_transaction_kind, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.wallet_adjust(
  public.wallet_account_type, uuid, numeric, public.wallet_transaction_kind, uuid, text, text
) to service_role;

do $$ begin
  revoke all on function public.match_ai_embeddings(vector, text, uuid, integer)
    from public, anon, authenticated;
  grant execute on function public.match_ai_embeddings(vector, text, uuid, integer)
    to service_role;
exception when undefined_function or undefined_object then
  null;  -- pgvector / the AI-native migration not applied on this database
end $$;

notify pgrst, 'reload schema';

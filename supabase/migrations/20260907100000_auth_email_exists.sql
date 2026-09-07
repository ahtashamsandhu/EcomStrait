-- ============================================================================
--  auth_email_exists(email) — does an account with this email exist?
--
--  The forgot-password form tells the user outright whether the address they
--  typed is on file (product decision: a wrong address should get "this email
--  does not exist" rather than a silent no-op). supabase-js has no
--  admin.getUserByEmail, and `auth.users` isn't reachable through PostgREST,
--  so this is the one sanctioned way for server code to ask.
--
--  Execute is granted to service_role ONLY. The browser must never be able to
--  call this directly — the server action decides what to reveal, and it is
--  the only caller.
-- ============================================================================

create or replace function public.auth_email_exists(p_email text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from auth.users u
    where lower(u.email) = lower(trim(p_email))
      and u.deleted_at is null
  );
$$;

revoke all on function public.auth_email_exists(text) from public, anon, authenticated;
grant execute on function public.auth_email_exists(text) to service_role;

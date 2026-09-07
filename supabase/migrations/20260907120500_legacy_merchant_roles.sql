-- ============================================================================
--  Security hardening 6 — legacy merchant roles.
--
--  OAuth sign-ups carry no role metadata, so merchants who joined through
--  Google were given the platform default (`supplier`). Creating a store now
--  requires the `business_owner` role (20260907120300), and the merchant
--  app's auth callback promotes such accounts on their next Google login —
--  this backfills the ones that already own stores so nothing waits on a
--  re-login. Accounts that run a supplier business are left alone.
-- ============================================================================
update public.profiles p
   set role = 'business_owner'
 where p.role = 'supplier'
   and exists (select 1 from public.stores s where s.user_id = p.user_id)
   and not exists (select 1 from public.suppliers sp where sp.owner_user_id = p.user_id);

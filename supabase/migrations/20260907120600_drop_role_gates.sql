-- ============================================================================
--  Security hardening 7 — remove the role gates on tenant-root inserts.
--
--  20260907120300 required `current_user_role() = 'supplier'` to create a
--  supplier row and `in ('business_owner','admin')` to create a store. That
--  blocks a legitimate account that uses both apps (one login, a supplier
--  business AND a store), and the auto-promotion that tried to patch around
--  it could not apply to exactly those accounts. The gate bought little:
--  the listing-approval bypass it was meant to narrow is closed outright by
--  enforce_listing_decision deriving supplier_id from the product, so
--  ownership alone is the right rule here again.
-- ============================================================================
drop policy if exists "suppliers_insert_own" on public.suppliers;
create policy "suppliers_insert_own" on public.suppliers
  for insert to authenticated
  with check (auth.uid() = owner_user_id);

drop policy if exists "stores_owner_insert" on public.stores;
create policy "stores_owner_insert" on public.stores
  for insert to authenticated
  with check (auth.uid() = user_id);

notify pgrst, 'reload schema';

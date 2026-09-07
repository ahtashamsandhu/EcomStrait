-- ============================================================================
--  Security hardening 4/4 — tenant integrity.
--
--  * store_products: the listing-decision trigger trusted a caller-supplied
--    supplier_id; it is now always derived from the product. Suppliers may
--    only touch the decision columns, merchants may not touch them at all.
--  * request_messages.sender is derived from who is writing.
--  * supplier_members: owners invite, the platform activates.
--  * usage counters are read-only for sessions; increments go through RPCs.
--  * products: published rows are readable by signed-in users only (wholesale
--    and MAP prices are not public data). Storefronts read via service role.
--  * stores: domain verification / Shopify linkage are platform-set, and the
--    plan's store limit is enforced on launch at the database.
--  * roles: only supplier accounts create supplier rows; only merchant
--    accounts create stores.
--  * storage: public buckets get size and MIME limits.
--  * stock: atomic adjust/set RPCs that also write the audit row.
-- ============================================================================

-- ---- 1. Listing decisions ---------------------------------------------------
create or replace function public.enforce_listing_decision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supplier_id uuid;
  is_supplier   boolean;
  is_merchant   boolean;
begin
  -- The listing's supplier is whoever owns the product. Never the caller's say.
  select p.supplier_id into v_supplier_id from public.products p where p.id = new.product_id;
  if v_supplier_id is null then
    raise exception 'Unknown product for listing' using errcode = 'foreign_key_violation';
  end if;
  new.supplier_id := v_supplier_id;

  if public.is_privileged() then
    return new;
  end if;

  is_supplier :=
    exists (select 1 from public.suppliers s
            where s.id = v_supplier_id and s.owner_user_id = auth.uid())
    or public.is_member(v_supplier_id);
  is_merchant :=
    exists (select 1 from public.stores st where st.id = new.store_id and st.user_id = auth.uid());

  if tg_op = 'INSERT' then
    if not is_supplier then
      new.status := 'pending';
      new.decided_at := null;
      new.decline_reason := null;
    end if;
    return new;
  end if;

  -- UPDATE
  if new.store_id is distinct from old.store_id or new.product_id is distinct from old.product_id then
    raise exception 'A listing cannot be re-pointed to another store or product'
      using errcode = 'check_violation';
  end if;

  if is_supplier and not is_merchant then
    -- A supplier decides; it does not edit the merchant's listing.
    if new.price          is distinct from old.price
       or new.shipping_note  is distinct from old.shipping_note
       or new.shopify_handle is distinct from old.shopify_handle then
      raise exception 'Only the merchant can edit listing details'
        using errcode = 'insufficient_privilege';
    end if;
    if new.status is distinct from old.status then
      new.decided_at := now();
      if new.status <> 'declined' then new.decline_reason := null; end if;
    end if;
    return new;
  end if;

  -- Merchant (or anyone else with row access): decision columns are frozen.
  if new.status         is distinct from old.status
     or new.decided_at     is distinct from old.decided_at
     or new.decline_reason is distinct from old.decline_reason then
    raise exception 'Only the supplier can approve or decline a listing request'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
-- (trigger store_products_decision_guard already points at this function)

-- ---- 2. request_messages.sender ------------------------------------------
create or replace function public.guard_request_messages()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_supplier_id uuid;
begin
  if public.is_privileged() then return new; end if;
  select r.supplier_id into v_supplier_id from public.product_requests r where r.id = new.request_id;
  if exists (select 1 from public.suppliers s where s.id = v_supplier_id and s.owner_user_id = auth.uid())
     or public.is_member(v_supplier_id) then
    if new.sender not in ('supplier', 'system') then new.sender := 'supplier'; end if;
  else
    new.sender := 'store_owner';
  end if;
  return new;
end;
$$;
drop trigger if exists request_messages_guard on public.request_messages;
create trigger request_messages_guard
  before insert on public.request_messages
  for each row execute function public.guard_request_messages();

do $$ begin
  alter table public.request_messages
    add constraint request_messages_sender_check
    check (sender in ('supplier', 'store_owner', 'system')) not valid;
exception when duplicate_object then null; end $$;

-- ---- 3. supplier_members ------------------------------------------------------
create or replace function public.guard_supplier_members()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_privileged() then return new; end if;
  if tg_op = 'INSERT' then
    new.status  := 'invited';
    new.user_id := null;
    new.role    := 'supplier_staff';
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.supplier_id is distinct from old.supplier_id
     or new.role is distinct from old.role
     or new.status not in ('invited', 'revoked') then
    raise exception 'Members are activated by the platform when they sign in'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
drop trigger if exists supplier_members_guard on public.supplier_members;
create trigger supplier_members_guard
  before insert or update on public.supplier_members
  for each row execute function public.guard_supplier_members();

-- ---- 4. Usage counters: read-only from sessions -------------------------------
drop policy if exists "usage_write_own" on public.usage_daily;
drop policy if exists "supplier_usage_write_own" on public.supplier_usage_daily;

create or replace function public.increment_token_usage(p_tokens integer)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_total bigint;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = 'insufficient_privilege'; end if;
  if p_tokens is null or p_tokens <= 0 then
    select tokens_used into v_total from public.usage_daily where user_id = auth.uid() and day = current_date;
    return coalesce(v_total, 0);
  end if;
  insert into public.usage_daily (user_id, day, tokens_used)
  values (auth.uid(), current_date, p_tokens)
  on conflict (user_id, day) do update set tokens_used = public.usage_daily.tokens_used + excluded.tokens_used
  returning tokens_used into v_total;
  return v_total;
end;
$$;
revoke all on function public.increment_token_usage(integer) from public, anon;
grant execute on function public.increment_token_usage(integer) to authenticated, service_role;

create or replace function public.increment_supplier_token_usage(p_supplier_id uuid, p_tokens integer)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_total bigint;
begin
  if not (
    public.is_privileged()
    or public.is_member(p_supplier_id)
    or exists (select 1 from public.suppliers s where s.id = p_supplier_id and s.owner_user_id = auth.uid())
  ) then
    raise exception 'Not authorized for this supplier' using errcode = 'insufficient_privilege';
  end if;
  if p_tokens is null or p_tokens <= 0 then
    select tokens_used into v_total from public.supplier_usage_daily
     where supplier_id = p_supplier_id and day = current_date;
    return coalesce(v_total, 0);
  end if;
  insert into public.supplier_usage_daily (supplier_id, day, tokens_used)
  values (p_supplier_id, current_date, p_tokens)
  on conflict (supplier_id, day) do update
    set tokens_used = public.supplier_usage_daily.tokens_used + excluded.tokens_used
  returning tokens_used into v_total;
  return v_total;
end;
$$;
revoke all on function public.increment_supplier_token_usage(uuid, integer) from public, anon;
grant execute on function public.increment_supplier_token_usage(uuid, integer) to authenticated, service_role;

-- ---- 5. products: no anonymous reads of wholesale data ------------------------
drop policy if exists "products_read_published" on public.products;
create policy "products_read_published" on public.products
  for select to authenticated
  using (status = 'published');

-- ---- 6. stores: platform-set columns + store limit ---------------------------
create or replace function public.store_limit_for(p_user_id uuid)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when s.status = 'active'
        or (s.status = 'trialing' and (s.trial_ends_at is null or s.trial_ends_at > now()))
      then case s.plan when 'free' then 1 when 'basic' then 2 when 'premium' then 10 when 'full' then 50 end
      else 1
    end
    from public.subscriptions s
    where s.user_id = p_user_id
  ), 1);
$$;
revoke all on function public.store_limit_for(uuid) from public, anon, authenticated;
grant execute on function public.store_limit_for(uuid) to service_role;

create or replace function public.guard_stores()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_launched integer;
  v_limit    integer;
begin
  if public.is_privileged() then return new; end if;

  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      raise exception 'stores.user_id is immutable' using errcode = 'insufficient_privilege';
    end if;
    -- May be cleared by the merchant, only set by the platform.
    if new.domain_verified_at is not null and new.domain_verified_at is distinct from old.domain_verified_at then
      raise exception 'Domain verification is recorded by the platform' using errcode = 'insufficient_privilege';
    end if;
    if new.shopify_store_id is not null and new.shopify_store_id is distinct from old.shopify_store_id then
      raise exception 'Shopify stores are attached by the platform' using errcode = 'insufficient_privilege';
    end if;
  else
    new.domain_verified_at := null;
    new.shopify_store_id   := null;
  end if;

  -- Launching (launched_at null -> set) counts against the plan.
  if new.launched_at is not null and (tg_op = 'INSERT' or old.launched_at is null) then
    select count(*) into v_launched from public.stores
     where user_id = new.user_id and launched_at is not null and id <> new.id;
    v_limit := public.store_limit_for(new.user_id);
    if v_launched >= v_limit then
      raise exception 'You''ve reached your plan''s store limit (%). Upgrade to add more.', v_limit
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists stores_guard on public.stores;
create trigger stores_guard
  before insert or update on public.stores
  for each row execute function public.guard_stores();

-- ---- 7. Role checks on tenant-root inserts ----------------------------------
drop policy if exists "suppliers_insert_own" on public.suppliers;
create policy "suppliers_insert_own" on public.suppliers
  for insert to authenticated
  with check (auth.uid() = owner_user_id and public.current_user_role() = 'supplier');

drop policy if exists "stores_owner_all" on public.stores;
create policy "stores_owner_select" on public.stores
  for select to authenticated using (auth.uid() = user_id);
create policy "stores_owner_insert" on public.stores
  for insert to authenticated
  with check (auth.uid() = user_id and public.current_user_role() in ('business_owner', 'admin'));
create policy "stores_owner_update" on public.stores
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "stores_owner_delete" on public.stores
  for delete to authenticated using (auth.uid() = user_id);

-- ---- 8. Storage: size + MIME limits on public buckets --------------------------
update storage.buckets
   set file_size_limit = 8 * 1024 * 1024,
       allowed_mime_types = array['image/jpeg','image/png','image/webp','image/avif','image/gif']
 where id in ('product-images', 'store-logos');
update storage.buckets
   set file_size_limit = 4 * 1024 * 1024,
       allowed_mime_types = array['image/jpeg','image/png','image/webp','image/avif']
 where id = 'avatars';
update storage.buckets
   set file_size_limit = 64 * 1024 * 1024,
       allowed_mime_types = array['image/jpeg','image/png','image/webp','image/avif','image/gif',
                                  'video/mp4','video/webm','video/quicktime']
 where id = 'store-assets';
update storage.buckets
   set file_size_limit = 16 * 1024 * 1024,
       allowed_mime_types = array['image/jpeg','image/png','image/webp','application/pdf']
 where id = 'supplier-documents';

-- ---- 9. Atomic stock changes that always leave an audit row ---------------------
create or replace function public.can_manage_product(p_product_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_privileged() or exists (
    select 1 from public.products p
    join public.suppliers s on s.id = p.supplier_id
    where p.id = p_product_id
      and s.status = 'approved'
      and (s.owner_user_id = auth.uid() or public.is_member(s.id))
  );
$$;
revoke all on function public.can_manage_product(uuid) from public, anon;
grant execute on function public.can_manage_product(uuid) to authenticated, service_role;

create or replace function public.adjust_product_stock(p_product_id uuid, p_delta integer, p_reason text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare v_new integer; v_old integer;
begin
  if not public.can_manage_product(p_product_id) then
    raise exception 'Product not found.' using errcode = 'insufficient_privilege';
  end if;
  if p_delta is null or p_delta = 0 then
    select stock into v_new from public.products where id = p_product_id;
    return v_new;
  end if;
  select stock into v_old from public.products where id = p_product_id for update;
  update public.products set stock = greatest(0, stock + p_delta)
   where id = p_product_id returning stock into v_new;
  insert into public.inventory_adjustments (product_id, delta, resulting_stock, reason)
  values (p_product_id, v_new - v_old, v_new, coalesce(p_reason, 'Adjustment'));
  return v_new;
end;
$$;
revoke all on function public.adjust_product_stock(uuid, integer, text) from public, anon;
grant execute on function public.adjust_product_stock(uuid, integer, text) to authenticated, service_role;

create or replace function public.set_product_stock(p_product_id uuid, p_stock integer, p_reason text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare v_old integer; v_new integer := greatest(0, coalesce(p_stock, 0));
begin
  if not public.can_manage_product(p_product_id) then
    raise exception 'Product not found.' using errcode = 'insufficient_privilege';
  end if;
  select stock into v_old from public.products where id = p_product_id for update;
  if v_old = v_new then return v_new; end if;
  update public.products set stock = v_new where id = p_product_id;
  insert into public.inventory_adjustments (product_id, delta, resulting_stock, reason)
  values (p_product_id, v_new - v_old, v_new, coalesce(p_reason, 'Manual update'));
  return v_new;
end;
$$;
revoke all on function public.set_product_stock(uuid, integer, text) from public, anon;
grant execute on function public.set_product_stock(uuid, integer, text) to authenticated, service_role;

grant execute on function public.guard_request_messages() to anon, authenticated, service_role;
grant execute on function public.guard_supplier_members() to anon, authenticated, service_role;
grant execute on function public.guard_stores() to anon, authenticated, service_role;

notify pgrst, 'reload schema';

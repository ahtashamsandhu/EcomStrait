-- ============================================================================
--  Security hardening 2/4 — privileged columns.
--
--  Several owner-scoped UPDATE policies are row-wide, so a user could change
--  columns the app treats as admin-only: their own `profiles.role`, their
--  supplier's `status` (KYC approval), verification timestamps, and the money
--  columns on `orders` that `reverse_cod_deduction` trusts.
--
--  Column-level GRANTs would break PostgREST's `select *` ergonomics, so this
--  uses BEFORE triggers instead: a request that is not privileged (no JWT,
--  service_role, or an admin profile) may not touch the guarded columns.
-- ============================================================================

-- ---- 0. Helper: is the current request privileged? ------------------------
--  auth.uid() is null for service_role requests, direct psql, and migrations.
create or replace function public.is_privileged()
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select auth.uid() is null
      or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      or public.is_admin();
$$;
revoke all on function public.is_privileged() from public, anon, authenticated;
grant execute on function public.is_privileged() to anon, authenticated, service_role;

-- ---- 1. profiles.role ------------------------------------------------------
create or replace function public.guard_profiles()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_privileged() then return new; end if;
  if new.role is distinct from old.role then
    raise exception 'Only an administrator can change a user''s role'
      using errcode = 'insufficient_privilege';
  end if;
  if new.user_id is distinct from old.user_id then
    raise exception 'profiles.user_id is immutable' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
  before update on public.profiles
  for each row execute function public.guard_profiles();

-- ---- 2. suppliers: status / owner / quality / return feedback -------------
--  A supplier may move pending <-> in_review themselves (that is the
--  onboarding submit); approved / rejected are admin decisions.
create or replace function public.guard_suppliers()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_privileged() then return new; end if;

  if tg_op = 'INSERT' then
    if new.status not in ('pending', 'in_review') then new.status := 'pending'; end if;
    new.quality_score  := null;
    new.return_reasons := '{}';
    new.return_note    := null;
    return new;
  end if;

  if new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'suppliers.owner_user_id is immutable' using errcode = 'insufficient_privilege';
  end if;
  if new.status is distinct from old.status then
    if not (old.status in ('pending', 'in_review') and new.status in ('pending', 'in_review')) then
      raise exception 'Only an administrator can approve or reject a supplier'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  if new.quality_score  is distinct from old.quality_score
     or new.return_reasons is distinct from old.return_reasons
     or new.return_note  is distinct from old.return_note then
    raise exception 'Quality score and return feedback are set by the platform'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
drop trigger if exists suppliers_guard on public.suppliers;
create trigger suppliers_guard
  before insert or update on public.suppliers
  for each row execute function public.guard_suppliers();

do $$ begin
  alter table public.suppliers
    add constraint suppliers_status_check
    check (status in ('pending', 'in_review', 'approved', 'rejected')) not valid;
exception when duplicate_object then null; end $$;

-- ---- 3. supplier_verification: only email_verified_at is self-service -----
create or replace function public.guard_supplier_verification()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_privileged() then return new; end if;
  if tg_op = 'INSERT' then
    new.phone_verified_at     := null;
    new.documents_verified_at := null;
    new.manual_reviewed_at    := null;
    new.badge_granted_at      := null;
    return new;
  end if;
  if new.phone_verified_at     is distinct from old.phone_verified_at
     or new.documents_verified_at is distinct from old.documents_verified_at
     or new.manual_reviewed_at    is distinct from old.manual_reviewed_at
     or new.badge_granted_at      is distinct from old.badge_granted_at
     or new.supplier_id           is distinct from old.supplier_id then
    raise exception 'Verification milestones are granted by the platform'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
drop trigger if exists supplier_verification_guard on public.supplier_verification;
create trigger supplier_verification_guard
  before insert or update on public.supplier_verification
  for each row execute function public.guard_supplier_verification();

-- ---- 4. supplier_documents.status -----------------------------------------
create or replace function public.guard_supplier_documents()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_privileged() then return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'uploaded';
    return new;
  end if;
  if new.status is distinct from old.status or new.supplier_id is distinct from old.supplier_id then
    raise exception 'Document review status is set by the platform'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
drop trigger if exists supplier_documents_guard on public.supplier_documents;
create trigger supplier_documents_guard
  before insert or update on public.supplier_documents
  for each row execute function public.guard_supplier_documents();

do $$ begin
  alter table public.supplier_documents
    add constraint supplier_documents_status_check
    check (status in ('uploaded', 'verified', 'rejected')) not valid;
exception when duplicate_object then null; end $$;

-- ---- 5. orders: money columns + status state machine ----------------------
--  Suppliers legitimately INSERT orders when accepting a request
--  (request-actions.ts) and UPDATE `status` / `shipping`. Everything the
--  wallet logic reads (payment_type, cost/margin/fee, credit_status,
--  store links) is written by the merchant app with the service role only.
create or replace function public.guard_orders()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  allowed boolean;
begin
  if public.is_privileged() then return new; end if;

  if tg_op = 'INSERT' then
    new.payment_type        := null;
    new.cost_amount         := null;
    new.margin_amount       := null;
    new.platform_fee_amount := null;
    new.credit_status       := 'deducted';
    new.store_id            := null;
    new.store_order_id      := null;
    if new.status is null or new.status not in ('processing') then
      new.status := 'processing';
    end if;
    return new;
  end if;

  -- UPDATE: only status and shipping may move.
  if new.supplier_id         is distinct from old.supplier_id
     or new.request_id          is distinct from old.request_id
     or new.store_id            is distinct from old.store_id
     or new.store_order_id      is distinct from old.store_order_id
     or new.payment_type        is distinct from old.payment_type
     or new.cost_amount         is distinct from old.cost_amount
     or new.margin_amount       is distinct from old.margin_amount
     or new.platform_fee_amount is distinct from old.platform_fee_amount
     or new.credit_status       is distinct from old.credit_status then
    raise exception 'Order payment fields are managed by the platform'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status is distinct from old.status then
    allowed := case old.status
      when 'processing' then new.status in ('shipped', 'cancelled')
      when 'shipped'    then new.status in ('delivered')
      else false
    end;
    if not allowed then
      raise exception 'Order cannot move from % to %', old.status, new.status
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists orders_guard on public.orders;
create trigger orders_guard
  before insert or update on public.orders
  for each row execute function public.guard_orders();

do $$ begin
  alter table public.orders
    add constraint orders_status_check
    check (status in ('processing', 'shipped', 'delivered', 'cancelled')) not valid;
exception when duplicate_object then null; end $$;

-- ---- 6. Plain CHECKs the schema was missing -------------------------------
do $$ begin
  alter table public.product_requests
    add constraint product_requests_status_check
    check (status in ('new', 'accepted', 'declined', 'proposed', 'fulfilled')) not valid;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.products
    add constraint products_status_check
    check (status in ('draft', 'published')) not valid;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.products
    add constraint products_money_nonnegative_check
    check (
      (wholesale_price is null or (wholesale_price >= 0 and wholesale_price <= 10000000))
      and (retail_price is null or (retail_price >= 0 and retail_price <= 10000000))
      and (map_price is null or (map_price >= 0 and map_price <= 10000000))
      and stock >= 0 and reserved >= 0 and low_stock_threshold >= 0
    ) not valid;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.products
    add constraint products_text_length_check
    check (
      char_length(title) <= 300
      and (description is null or char_length(description) <= 20000)
      and (category is null or char_length(category) <= 120)
      and (sku is null or char_length(sku) <= 120)
      and (seo_title is null or char_length(seo_title) <= 300)
      and (seo_description is null or char_length(seo_description) <= 1000)
      and cardinality(images) <= 30
    ) not valid;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.request_messages
    add constraint request_messages_body_length_check
    check (char_length(body) <= 10000) not valid;
exception when duplicate_object then null; end $$;

grant execute on function public.guard_profiles() to anon, authenticated, service_role;
grant execute on function public.guard_suppliers() to anon, authenticated, service_role;
grant execute on function public.guard_supplier_verification() to anon, authenticated, service_role;
grant execute on function public.guard_supplier_documents() to anon, authenticated, service_role;
grant execute on function public.guard_orders() to anon, authenticated, service_role;

notify pgrst, 'reload schema';

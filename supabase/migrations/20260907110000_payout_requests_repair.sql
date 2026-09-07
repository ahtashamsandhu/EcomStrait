-- Repair: bring `payout_requests` up to the shape 20260904120000 describes.
--
-- The hosted project's `payout_requests` table was created from an early draft
-- of that migration — id / account / amount / status / note / timestamps only.
-- Because the migration uses `create table if not exists`, re-running the
-- final version was a no-op, so the bank-detail columns, the receipt/admin
-- columns, the payable_ledger link, the 'paid_out' enum value, and the
-- private receipts bucket never reached the database. Submitting a withdrawal
-- then failed with "Could not find the 'bank_account_name' column of
-- 'payout_requests' in the schema cache".
--
-- Every statement here is idempotent, so it is safe on a database that
-- already has some or all of these pieces.

-- ---- bank details + admin review columns ---------------------------------
-- Added nullable first, backfilled, then constrained — a `not null` column
-- with no default can't be added to a table that already has rows.
alter table public.payout_requests add column if not exists bank_account_name   text;
alter table public.payout_requests add column if not exists bank_name           text;
alter table public.payout_requests add column if not exists bank_account_number text;
alter table public.payout_requests add column if not exists bank_routing_code   text;
alter table public.payout_requests add column if not exists receipt_path        text;
alter table public.payout_requests add column if not exists admin_note          text;

update public.payout_requests
   set bank_account_name   = coalesce(bank_account_name, ''),
       bank_name           = coalesce(bank_name, ''),
       bank_account_number = coalesce(bank_account_number, '')
 where bank_account_name is null or bank_name is null or bank_account_number is null;

alter table public.payout_requests alter column bank_account_name   set not null;
alter table public.payout_requests alter column bank_name           set not null;
alter table public.payout_requests alter column bank_account_number set not null;

-- ---- payable_ledger link (see 20260904120000 for the reasoning) ----------
alter table public.payable_ledger add column if not exists payout_request_id uuid
  references public.payout_requests (id) on delete set null;

create index if not exists payable_ledger_payout_request_idx
  on public.payable_ledger (payout_request_id)
  where payout_request_id is not null;

alter type public.payable_status add value if not exists 'paid_out';

-- ---- RLS (re-asserted in case the draft never enabled it) ----------------
alter table public.payout_requests enable row level security;

drop policy if exists "payout_requests_select_own" on public.payout_requests;
create policy "payout_requests_select_own" on public.payout_requests
  for select to authenticated using (
    public.is_admin()
    or (account_type = 'merchant' and account_id = auth.uid())
    or (account_type = 'supplier' and exists (
          select 1 from public.suppliers s
          where s.id = account_id and s.owner_user_id = auth.uid()))
  );

drop policy if exists "payout_requests_insert_own" on public.payout_requests;
create policy "payout_requests_insert_own" on public.payout_requests
  for insert to authenticated with check (
    (account_type = 'merchant' and account_id = auth.uid())
    or (account_type = 'supplier' and exists (
          select 1 from public.suppliers s
          where s.id = account_id and s.owner_user_id = auth.uid()))
  );

drop policy if exists "payout_requests_admin_update" on public.payout_requests;
create policy "payout_requests_admin_update" on public.payout_requests
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---- payout-receipts bucket ----------------------------------------------
insert into storage.buckets (id, name, public)
values ('payout-receipts', 'payout-receipts', false)
on conflict (id) do nothing;

drop policy if exists "payout_receipts_read" on storage.objects;
create policy "payout_receipts_read" on storage.objects
  for select to authenticated using (
    bucket_id = 'payout-receipts' and (
      public.is_admin()
      or exists (
        select 1 from public.payout_requests pr
        where pr.id::text = (storage.foldername(name))[1]
          and (
            (pr.account_type = 'merchant' and pr.account_id = auth.uid())
            or (pr.account_type = 'supplier' and exists (
                  select 1 from public.suppliers s
                  where s.id = pr.account_id and s.owner_user_id = auth.uid()))
          )
      )
    )
  );

drop policy if exists "payout_receipts_write_admin" on storage.objects;
create policy "payout_receipts_write_admin" on storage.objects
  for all to authenticated
  using (bucket_id = 'payout-receipts' and public.is_admin())
  with check (bucket_id = 'payout-receipts' and public.is_admin());

-- PostgREST caches the schema; make it pick the new columns up right away.
notify pgrst, 'reload schema';

-- ============================================================================
--  Security hardening 3/4 — money paths.
--
--  * reverse_cod_deduction trusted orders.margin_amount/platform_fee_amount.
--    Those columns are now guarded (2/4), and the function additionally
--    recomputes the refund from the ledger row that actually debited the
--    wallet, so a forged order row can never mint credit. Active staff may
--    trigger it too — they can cancel orders, and the reversal must follow.
--  * payout_requests could be inserted directly with any amount and raced
--    into duplicates. Requests now go through request_payout(), which locks,
--    sums the unheld pending payables, inserts and earmarks in one
--    transaction. A partial unique index makes "one pending request per
--    account" a database fact.
-- ============================================================================

-- ---- 1. reverse_cod_deduction: refund what the ledger says was taken ------
create or replace function public.reverse_cod_deduction(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order       public.orders%rowtype;
  v_debited     numeric(12, 2);
  v_new_balance numeric(12, 2);
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return false;
  end if;

  if v_order.payment_type is distinct from 'cod'
     or v_order.credit_status <> 'deducted'
     or v_order.status <> 'cancelled' then
    return false;
  end if;

  if not (
    public.is_privileged()
    or public.is_member(v_order.supplier_id)
    or exists (select 1 from public.suppliers s
               where s.id = v_order.supplier_id and s.owner_user_id = auth.uid())
  ) then
    raise exception 'Not authorized to reverse this order.' using errcode = 'insufficient_privilege';
  end if;

  -- The original up-front deduction(s) for this order, as recorded when the
  -- money actually moved. Debits are stored negative.
  select coalesce(-sum(amount), 0) into v_debited
    from public.wallet_transactions
   where order_id = p_order_id
     and account_type = 'supplier'
     and account_id = v_order.supplier_id
     and kind = 'order_deduction';

  if v_debited <= 0 then
    -- Nothing was ever taken for this order: nothing to give back.
    update public.orders set credit_status = 'reversed' where id = p_order_id;
    return false;
  end if;

  v_new_balance := public.wallet_adjust(
    'supplier', v_order.supplier_id, v_debited,
    'reversal', p_order_id, 'COD order cancelled before delivery',
    'cod-reversal:' || p_order_id::text  -- idempotent: a second call is a no-op
  );

  delete from public.payable_ledger
   where order_id = p_order_id and account_type = 'merchant' and status = 'pending';

  update public.orders set credit_status = 'reversed' where id = p_order_id;
  return v_new_balance is not null;
end;
$$;
revoke all on function public.reverse_cod_deduction(uuid) from public, anon;
grant execute on function public.reverse_cod_deduction(uuid) to authenticated, service_role;

-- ---- 2. One pending payout request per account ----------------------------
create unique index if not exists payout_requests_one_pending_idx
  on public.payout_requests (account_type, account_id)
  where status = 'pending';

-- ---- 3. request_payout(): the only way to open a request ------------------
create or replace function public.request_payout(
  p_account_type        public.wallet_account_type,
  p_amount              numeric(12, 2),
  p_bank_account_name   text,
  p_bank_name           text,
  p_bank_account_number text,
  p_bank_routing_code   text default null,
  p_note                text default null
) returns table (request_id uuid, amount numeric(12, 2))
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid;
  v_available  numeric(12, 2);
  v_covered    numeric(12, 2) := 0;
  v_ids        uuid[] := '{}';
  v_row        record;
  v_request_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter a withdrawal amount.' using errcode = 'check_violation';
  end if;
  if coalesce(trim(p_bank_account_name), '') = ''
     or coalesce(trim(p_bank_name), '') = ''
     or coalesce(trim(p_bank_account_number), '') = '' then
    raise exception 'Account holder name, bank name, and account number are all required.'
      using errcode = 'check_violation';
  end if;

  -- Resolve the account the caller is allowed to withdraw for.
  if p_account_type = 'merchant' then
    v_account_id := auth.uid();
  else
    select s.id into v_account_id
      from public.suppliers s
     where s.owner_user_id = auth.uid();
  end if;
  if v_account_id is null then
    raise exception 'Not authorized to request a payout for this account.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Serialise concurrent requests for the same account.
  perform pg_advisory_xact_lock(hashtext('payout:' || p_account_type::text || ':' || v_account_id::text));

  if exists (select 1 from public.payout_requests
              where account_type = p_account_type and account_id = v_account_id
                and status = 'pending') then
    raise exception 'You already have a withdrawal request pending review.'
      using errcode = 'unique_violation';
  end if;

  select coalesce(sum(pl.amount), 0) into v_available
    from public.payable_ledger pl
   where pl.account_type = p_account_type and pl.account_id = v_account_id
     and pl.status = 'pending' and not pl.held and pl.payout_request_id is null;

  if v_available <= 0 then
    raise exception 'Nothing pending to withdraw yet.' using errcode = 'check_violation';
  end if;
  if p_amount > v_available then
    raise exception 'You can withdraw up to $%.', to_char(v_available, 'FM999999990.00')
      using errcode = 'check_violation';
  end if;

  -- Oldest payables first, until the request is covered (each row is one
  -- order, so the real figure can land a little above what was typed).
  for v_row in
    select pl.id, pl.amount
      from public.payable_ledger pl
     where pl.account_type = p_account_type and pl.account_id = v_account_id
       and pl.status = 'pending' and not pl.held and pl.payout_request_id is null
     order by pl.created_at asc
     for update
  loop
    exit when v_covered >= p_amount;
    v_ids := v_ids || v_row.id;
    v_covered := v_covered + v_row.amount;
  end loop;

  insert into public.payout_requests
    (account_type, account_id, amount, bank_account_name, bank_name,
     bank_account_number, bank_routing_code, note)
  values
    (p_account_type, v_account_id, v_covered, trim(p_bank_account_name), trim(p_bank_name),
     trim(p_bank_account_number), nullif(trim(coalesce(p_bank_routing_code, '')), ''),
     nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_request_id;

  update public.payable_ledger
     set held = true, payout_request_id = v_request_id
   where id = any(v_ids);

  request_id := v_request_id;
  amount := v_covered;
  return next;
end;
$$;
revoke all on function public.request_payout(public.wallet_account_type, numeric, text, text, text, text, text)
  from public, anon;
grant execute on function public.request_payout(public.wallet_account_type, numeric, text, text, text, text, text)
  to authenticated, service_role;

-- Direct inserts are no longer allowed from a session; the RPC is the door.
drop policy if exists "payout_requests_insert_own" on public.payout_requests;

notify pgrst, 'reload schema';

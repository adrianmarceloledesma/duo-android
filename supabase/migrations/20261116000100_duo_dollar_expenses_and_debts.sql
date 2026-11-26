begin;

-- Older Duo clients recognize the original kinds as pesos. Retain those kinds
-- and give dollar expenses and payments their own kinds so old clients skip them.
alter table public.duo_movements
  drop constraint duo_movements_check,
  add constraint duo_movements_check check (
    (
      ((kind = 'expense' and currency = 'ARS') or (kind = 'expense-usd' and currency = 'USD'))
      and category is not null and saving_kind is null and recipient_id is null and amount = trunc(amount)
    ) or (
      kind = 'income' and currency = 'ARS'
      and category is null and saving_kind is null and recipient_id is null and pair_id is null
    ) or (
      kind = 'saving' and category is null and saving_kind is not null and recipient_id is null
    ) or (
      ((kind = 'transfer' and currency = 'ARS') or (kind in ('transfer-usd', 'debt') and currency = 'USD'))
      and category is null and saving_kind is null and recipient_id is not null and recipient_id <> owner_id
      and pair_id is not null
      and (kind <> 'debt' or (amount = trunc(amount) and btrim(note) <> ''))
    )
  );

-- Called by the write functions under the existing pair lock.
create function public.duo_debt_available(
  p_pair uuid, p_caller uuid, p_currency text, p_exclude uuid
) returns numeric
language sql stable set search_path = '' as $$
  select coalesce(sum(case
    when m.kind in ('expense', 'expense-usd') then
      case when m.owner_id = p_caller then -m.amount / 2 else m.amount / 2 end
    when m.kind = 'debt' then case when m.owner_id = p_caller then m.amount else -m.amount end
    else case when m.owner_id = p_caller then -m.amount else m.amount end
  end), 0)
  from public.duo_movements m
  where m.pair_id = p_pair and m.currency = p_currency and m.deleted_at is null
    and m.kind in ('expense', 'expense-usd', 'transfer', 'transfer-usd', 'debt')
    and (p_exclude is null or m.id <> p_exclude);
$$;

revoke all on function public.duo_debt_available(uuid, uuid, text, uuid) from public, anon, authenticated;

create function public.duo_change_expense_currency(
  p_id uuid, p_delete boolean, p_amount numeric, p_category text, p_note text, p_date date, p_shared boolean, p_currency text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  target public.duo_movements%rowtype;
  new_pair uuid;
  affected_pair uuid;
begin
  if caller is null then
    raise exception 'duo_expense_unavailable';
  end if;

  -- Match the lock order used by duo_add_movement before recalculating debt.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));
  select m.* into target from public.duo_movements m
  where m.id = p_id and m.owner_id = caller and m.kind in ('expense', 'expense-usd');

  if not found or (target.deleted_at is not null and p_delete is distinct from true) then
    raise exception 'duo_expense_unavailable';
  end if;
  if target.deleted_at is not null then
    return;
  end if;

  if p_delete is distinct from true then
    if p_delete is null or p_currency is null or p_currency not in ('ARS', 'USD') or p_amount is null or p_amount <= 0 or p_amount > 999999999999
      or p_amount <> trunc(p_amount) or p_date is null or not isfinite(p_date)
      or p_category is null or p_category !~ '^[a-z][a-z-]{0,39}$'
      or char_length(coalesce(p_note, '')) > 500 or p_shared is null then
      raise exception 'duo_invalid_movement';
    end if;

    if p_shared then
      new_pair := public.duo_current_pair();
      if not exists (
        select 1 from public.duo_pair_members m where m.pair_id = new_pair and m.user_id <> caller
      ) then
        raise exception 'duo_link_required';
      end if;
    end if;
  end if;

  affected_pair := coalesce(target.pair_id, new_pair);
  if affected_pair is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(affected_pair::text, 1));
  end if;

  if p_delete then
    update public.duo_movements set deleted_at = now() where id = target.id;
  else
    update public.duo_movements
    set amount = p_amount, category = p_category, note = coalesce(p_note, ''),
        movement_date = p_date, pair_id = new_pair, currency = p_currency,
        kind = case when p_currency = 'USD' then 'expense-usd' else 'expense' end
    where id = target.id;
  end if;
end;
$$;

revoke all on function public.duo_change_expense_currency(uuid, boolean, numeric, text, text, date, boolean, text)
  from public, anon, authenticated;
grant execute on function public.duo_change_expense_currency(uuid, boolean, numeric, text, text, date, boolean, text)
  to authenticated;

create or replace function public.duo_change_movement(
  p_id uuid, p_kind text, p_delete boolean, p_amount numeric, p_date date, p_note text,
  p_saving_kind text, p_exclude_from_monthly_cash boolean
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  target public.duo_movements%rowtype;
  available numeric;
begin
  if caller is null or p_kind is null or p_kind not in ('income', 'saving', 'transfer', 'transfer-usd', 'debt') then
    raise exception 'duo_movement_unavailable';
  end if;

  -- Match the lock order used for adding a movement.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));
  select m.* into target from public.duo_movements m
  where m.id = p_id and m.kind = p_kind and m.owner_id = caller;

  if not found or (target.deleted_at is not null and p_delete is distinct from true) then
    raise exception 'duo_movement_unavailable';
  end if;
  if target.deleted_at is not null then
    return;
  end if;

  if p_delete is null or (not p_delete and (
    p_amount is null or p_amount <= 0 or p_amount > 999999999999 or p_amount <> round(p_amount, 2)
    or p_date is null or not isfinite(p_date) or char_length(coalesce(p_note, '')) > 500
    or (p_kind = 'debt' and (p_amount <> trunc(p_amount) or btrim(coalesce(p_note, '')) = ''))
    or p_exclude_from_monthly_cash is null
    or (p_kind = 'saving' and (p_saving_kind is null or p_saving_kind not in ('deposit', 'withdraw')))
    or (p_exclude_from_monthly_cash and (
      p_kind <> 'saving' or p_saving_kind <> 'deposit' or target.currency <> 'ARS'
    ))
  )) then
    raise exception 'duo_invalid_movement';
  end if;

  if target.pair_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target.pair_id::text, 1));
  end if;

  if p_kind = 'saving' then
    select coalesce(sum(case when m.saving_kind = 'deposit' then m.amount else -m.amount end), 0)
    into available from public.duo_movements m
    where m.kind = 'saving' and m.currency = target.currency and m.deleted_at is null
      and m.id <> target.id and m.pair_id is not distinct from target.pair_id
      and (target.pair_id is not null or m.owner_id = caller);
    if available + (case when p_delete then 0 when p_saving_kind = 'deposit' then p_amount else -p_amount end) < 0 then
      raise exception 'duo_saving_balance_negative';
    end if;
  elsif p_kind in ('transfer', 'transfer-usd') and not p_delete and p_amount > target.amount then
    available := public.duo_debt_available(target.pair_id, caller, target.currency, target.id);
    if p_amount > available then
      raise exception 'duo_transfer_exceeds_debt';
    end if;
  end if;

  if p_delete then
    update public.duo_movements set deleted_at = now() where id = target.id;
  else
    update public.duo_movements
    set movement_date = p_date, amount = p_amount, note = coalesce(p_note, ''),
        saving_kind = case when p_kind = 'saving' then p_saving_kind end,
        exclude_from_monthly_cash = p_exclude_from_monthly_cash
    where id = target.id;
  end if;
end;
$$;

revoke all on function public.duo_change_movement(uuid, text, boolean, numeric, date, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.duo_change_movement(uuid, text, boolean, numeric, date, text, text, boolean)
  to authenticated;

-- Both debt and savings checks operate on the active ledger.
create or replace function public.duo_add_movement(
  p_request_key text, p_kind text, p_amount numeric, p_date date, p_shared boolean,
  p_currency text, p_category text, p_note text, p_saving_kind text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  current_pair uuid;
  partner uuid;
  amount_available numeric;
begin
  if not exists (select 1 from public.duo_profiles p where p.user_id = caller) then
    raise exception 'duo_profile_required';
  end if;
  if p_currency is null or p_currency not in ('ARS', 'USD')
    or p_request_key is null or char_length(p_request_key) not between 1 and 100
    or p_amount is null or p_amount <= 0 or p_amount > 999999999999 or p_amount <> round(p_amount, 2)
    or p_date is null or not isfinite(p_date) or p_shared is null or p_kind is null
    or p_kind not in ('expense', 'expense-usd', 'income', 'saving', 'transfer', 'transfer-usd', 'debt')
    or (p_kind in ('expense', 'income', 'transfer') and p_currency <> 'ARS')
    or (p_kind in ('expense-usd', 'transfer-usd', 'debt') and p_currency <> 'USD')
    or (p_kind = 'debt' and (p_amount <> trunc(p_amount) or btrim(coalesce(p_note, '')) = ''))
  then
    raise exception 'duo_invalid_movement';
  end if;

  if p_shared or p_kind in ('transfer', 'transfer-usd', 'debt') then
    current_pair := public.duo_current_pair();
    select m.user_id into partner from public.duo_pair_members m
    where m.pair_id = current_pair and m.user_id <> caller;
    if partner is null then
      raise exception 'duo_link_required';
    end if;
  end if;

  -- Serialize a member's requests, then changes to the shared ledger.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));
  if current_pair is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(current_pair::text, 1));
  end if;

  if exists (select 1 from public.duo_movements m where m.owner_id = caller and m.request_key = p_request_key) then
    return;
  end if;

  if p_kind in ('transfer', 'transfer-usd') then
    amount_available := public.duo_debt_available(current_pair, caller, p_currency, null);
    if p_amount > amount_available then
      raise exception 'duo_transfer_exceeds_debt';
    end if;
  elsif p_kind = 'saving' and p_saving_kind = 'withdraw' then
    select coalesce(sum(case when m.saving_kind = 'deposit' then m.amount else -m.amount end), 0)
    into amount_available from public.duo_movements m
    where m.kind = 'saving' and m.currency = p_currency and m.deleted_at is null
      and ((current_pair is null and m.pair_id is null and m.owner_id = caller) or m.pair_id = current_pair);
    if p_amount > amount_available then
      raise exception 'duo_insufficient_savings';
    end if;
  end if;

  insert into public.duo_movements
    (owner_id, pair_id, recipient_id, request_key, movement_date, kind, amount, currency, category, note, saving_kind)
  values
    (caller, current_pair, case when p_kind in ('transfer', 'transfer-usd', 'debt') then partner end, p_request_key,
      p_date, p_kind, p_amount, p_currency, p_category, coalesce(p_note, ''), p_saving_kind);
end;
$$;

commit;

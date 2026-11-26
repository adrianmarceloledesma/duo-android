begin;

-- Retain the request key so a retry of the original save cannot recreate a deleted expense.
alter table public.duo_movements add column deleted_at timestamptz;

alter policy duo_movement_read on public.duo_movements using (
  deleted_at is null
  and (owner_id = (select auth.uid()) or pair_id = (select public.duo_current_pair()))
);

create function public.duo_change_expense(
  p_id uuid, p_delete boolean, p_amount numeric, p_category text, p_note text, p_date date, p_shared boolean
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
  where m.id = p_id and m.owner_id = caller and m.kind = 'expense';

  if not found or (target.deleted_at is not null and p_delete is distinct from true) then
    raise exception 'duo_expense_unavailable';
  end if;
  if target.deleted_at is not null then
    return;
  end if;

  if p_delete is distinct from true then
    if p_delete is null or p_amount is null or p_amount <= 0 or p_amount > 999999999999
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
        movement_date = p_date, pair_id = new_pair
    where id = target.id;
  end if;
end;
$$;

revoke all on function public.duo_change_expense(uuid, boolean, numeric, text, text, date, boolean)
  from public, anon, authenticated;
grant execute on function public.duo_change_expense(uuid, boolean, numeric, text, text, date, boolean)
  to authenticated;

-- The transfer check runs as owner and must exclude deleted expenses explicitly.
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
  if p_request_key is null or char_length(p_request_key) not between 1 and 100
    or p_amount is null or p_amount <= 0 or p_amount > 999999999999 or p_amount <> round(p_amount, 2)
    or p_date is null or not isfinite(p_date) or p_shared is null or p_kind is null
    or p_kind not in ('expense', 'income', 'saving', 'transfer') then
    raise exception 'duo_invalid_movement';
  end if;

  if p_shared or p_kind = 'transfer' then
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

  if p_kind = 'transfer' then
    select coalesce(sum(case
      when m.kind = 'expense' and m.owner_id = caller then -m.amount / 2
      when m.kind = 'expense' then m.amount / 2
      when m.owner_id = caller then -m.amount
      else m.amount end), 0)
    into amount_available from public.duo_movements m
    where m.pair_id = current_pair and m.kind in ('expense', 'transfer') and m.deleted_at is null;
    if p_amount > amount_available then
      raise exception 'duo_transfer_exceeds_debt';
    end if;
  elsif p_kind = 'saving' and p_saving_kind = 'withdraw' then
    select coalesce(sum(case when m.saving_kind = 'deposit' then m.amount else -m.amount end), 0)
    into amount_available from public.duo_movements m
    where m.kind = 'saving' and m.currency = p_currency
      and ((current_pair is null and m.pair_id is null and m.owner_id = caller) or m.pair_id = current_pair);
    if p_amount > amount_available then
      raise exception 'duo_insufficient_savings';
    end if;
  end if;

  insert into public.duo_movements
    (owner_id, pair_id, recipient_id, request_key, movement_date, kind, amount, currency, category, note, saving_kind)
  values
    (caller, current_pair, case when p_kind = 'transfer' then partner end, p_request_key,
      p_date, p_kind, p_amount, p_currency, p_category, coalesce(p_note, ''), p_saving_kind);
end;
$$;

commit;

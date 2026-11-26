begin;

-- The owner is always the author. For a receivable the recipient is the debtor.
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
      ((kind = 'transfer' and currency = 'ARS')
        or (kind in ('transfer-usd', 'debt', 'debt-receivable') and currency = 'USD'))
      and category is null and saving_kind is null and recipient_id is not null and recipient_id <> owner_id
      and pair_id is not null
      and (kind not in ('debt', 'debt-receivable') or (amount = trunc(amount) and btrim(note) <> ''))
    )
  );

create or replace function public.duo_debt_available(
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
    and m.kind in ('expense', 'expense-usd', 'transfer', 'transfer-usd', 'debt', 'debt-receivable')
    and (p_exclude is null or m.id <> p_exclude);
$$;

create function public.duo_save_debt_receivable(
  p_request_key text, p_id uuid, p_delete boolean, p_amount numeric, p_date date, p_note text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  target public.duo_movements%rowtype;
  current_pair uuid;
  debtor uuid;
begin
  if not exists (select 1 from public.duo_profiles p where p.user_id = caller) then
    raise exception 'duo_profile_required';
  end if;
  if p_delete is null
    or (p_id is null and (p_delete or p_request_key is null or char_length(p_request_key) not between 1 and 100))
    or (not p_delete and (
      p_amount is null or p_amount <= 0 or p_amount > 999999999999 or p_amount <> trunc(p_amount)
      or p_date is null or not isfinite(p_date) or char_length(btrim(coalesce(p_note, ''))) not between 1 and 500
    )) then
    raise exception 'duo_invalid_movement';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));
  if p_id is null then
    if exists (select 1 from public.duo_movements m where m.owner_id = caller and m.request_key = p_request_key) then
      return;
    end if;
    current_pair := public.duo_current_pair();
    select m.user_id into debtor from public.duo_pair_members m
    where m.pair_id = current_pair and m.user_id <> caller;
    if debtor is null then
      raise exception 'duo_link_required';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(current_pair::text, 1));
    insert into public.duo_movements
      (owner_id, pair_id, recipient_id, request_key, movement_date, kind, amount, currency, note)
    values (caller, current_pair, debtor, p_request_key, p_date, 'debt-receivable', p_amount, 'USD', btrim(p_note));
    return;
  end if;

  select m.* into target from public.duo_movements m
  where m.id = p_id and m.owner_id = caller and m.kind = 'debt-receivable';

  if not found or (target.deleted_at is not null and not p_delete) then
    raise exception 'duo_movement_unavailable';
  end if;
  if target.deleted_at is not null then
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target.pair_id::text, 1));

  if p_delete then
    update public.duo_movements set deleted_at = now() where id = target.id;
  else
    update public.duo_movements set movement_date = p_date, amount = p_amount, note = btrim(p_note)
    where id = target.id;
  end if;
end;
$$;

revoke all on function public.duo_save_debt_receivable(text, uuid, boolean, numeric, date, text)
  from public, anon, authenticated;
grant execute on function public.duo_save_debt_receivable(text, uuid, boolean, numeric, date, text)
  to authenticated;

commit;

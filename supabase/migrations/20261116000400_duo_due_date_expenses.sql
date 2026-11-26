begin;

alter table public.duo_due_dates
  add column if not exists category text check (category ~ '^[a-z][a-z-]{0,39}$'),
  add column if not exists payment_expense_ids uuid[] not null default '{}';

create or replace function public.duo_save_due_date(
  p_id uuid, p_key text, p_title text, p_due_on date, p_amount numeric, p_currency text, p_category text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then raise exception 'duo_due_date_unavailable'; end if;
  if p_id is null then
    if p_key is null or char_length(p_key) not between 1 and 100 then
      raise exception 'duo_invalid_due_date';
    end if;
    insert into public.duo_due_dates (owner_id, title, due_on, amount, currency, category, request_key)
    values (caller, btrim(p_title), p_due_on, p_amount, p_currency, p_category, p_key)
    on conflict (owner_id, request_key) do nothing;
  else
    update public.duo_due_dates set title = btrim(p_title), due_on = p_due_on, amount = p_amount,
      currency = p_currency, category = p_category
    where id = p_id and owner_id = caller and deleted_at is null;
    if not found then raise exception 'duo_due_date_unavailable'; end if;
  end if;
end;
$$;

create or replace function public.duo_copy_due_dates(p_month date, p_ids uuid[], p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then raise exception 'duo_due_date_unavailable'; end if;
  if p_month is null or not isfinite(p_month) or extract(day from p_month) <> 1 or p_ids is null
    or p_key is null or char_length(p_key) not between 1 and 100
  then raise exception 'duo_invalid_due_date'; end if;

  insert into public.duo_due_dates (owner_id, title, due_on, amount, currency, category, source_id, copied_month, request_key)
  select caller, item.title,
    p_month + (least(extract(day from item.due_on)::int, (p_month + interval '1 month')::date - p_month) - 1),
    item.amount, item.currency, item.category, item.id, p_month, p_key || ':' || item.id::text
  from public.duo_due_dates item
  where item.owner_id = caller and item.id = any(p_ids) and item.deleted_at is null
    and item.due_on >= (p_month - interval '1 month')::date and item.due_on < p_month
  on conflict do nothing;
end;
$$;

create or replace function public.duo_pay_due_date(
  p_id uuid, p_key text, p_paid_on date, p_total numeric, p_shared_amount numeric
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  item public.duo_due_dates%rowtype;
  personal_key text := p_id::text || ':' || p_key || ':personal';
  shared_key text := p_id::text || ':' || p_key || ':shared';
  expense_kind text;
begin
  if caller is null then raise exception 'duo_due_date_unavailable'; end if;
  if p_key is null or char_length(p_key) not between 1 and 48
    or p_paid_on is null or not isfinite(p_paid_on)
    or (p_total is null and p_shared_amount is not null)
    or (p_total is not null and (
      p_total <= 0 or p_total > 999999999999 or p_total <> trunc(p_total)
      or p_shared_amount is null or p_shared_amount < 0 or p_shared_amount > p_total
      or p_shared_amount <> trunc(p_shared_amount)
    ))
  then raise exception 'duo_invalid_due_date_payment'; end if;

  -- Use the same member lock as expense creation before locking a due date.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));
  select * into item from public.duo_due_dates d
    where d.id = p_id and d.owner_id = caller and d.deleted_at is null for update;
  if not found then raise exception 'duo_due_date_unavailable'; end if;

  if p_total is null then
    update public.duo_due_dates set paid_on = p_paid_on where id = p_id and paid_on is null;
    return;
  end if;
  if exists (
    select 1 from public.duo_movements m where m.owner_id = caller and m.request_key in (personal_key, shared_key)
  ) then return; end if;
  if item.paid_on is not null or exists (
    select 1 from public.duo_movements m where m.id = any(item.payment_expense_ids)
      and m.owner_id = caller and m.deleted_at is null
  ) then raise exception 'duo_due_date_expense_exists'; end if;

  expense_kind := case when item.currency = 'USD' then 'expense-usd' else 'expense' end;
  if p_total > p_shared_amount then
    perform public.duo_add_movement(personal_key, expense_kind, p_total - p_shared_amount, p_paid_on,
      false, item.currency, coalesce(item.category, 'otros'), item.title, null);
  end if;
  if p_shared_amount > 0 then
    perform public.duo_add_movement(shared_key, expense_kind, p_shared_amount, p_paid_on,
      true, item.currency, coalesce(item.category, 'otros'), item.title, null);
  end if;
  update public.duo_due_dates
    set paid_on = p_paid_on, payment_expense_ids = array(
      select m.id from public.duo_movements m where m.owner_id = caller and m.request_key in (personal_key, shared_key)
    )
    where id = p_id;
end;
$$;

revoke all on function public.duo_save_due_date(uuid, text, text, date, numeric, text, text)
  from public, anon, authenticated;
revoke all on function public.duo_pay_due_date(uuid, text, date, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.duo_save_due_date(uuid, text, text, date, numeric, text, text) to authenticated;
grant execute on function public.duo_pay_due_date(uuid, text, date, numeric, numeric) to authenticated;

commit;

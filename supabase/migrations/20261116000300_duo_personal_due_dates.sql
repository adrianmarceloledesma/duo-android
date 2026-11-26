begin;

create table public.duo_due_dates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.duo_profiles (user_id),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  due_on date not null check (isfinite(due_on)),
  amount numeric check (amount > 0 and amount <= 999999999999 and amount = trunc(amount)),
  currency text not null check (currency in ('ARS', 'USD')),
  paid_on date check (isfinite(paid_on)),
  request_key text,
  source_id uuid references public.duo_due_dates (id),
  copied_month date,
  deleted_at timestamptz,
  unique (owner_id, request_key)
);

create index duo_due_dates_active_owner_idx on public.duo_due_dates (owner_id, id) where deleted_at is null;
create unique index duo_due_dates_active_copy_idx on public.duo_due_dates (owner_id, source_id, copied_month) where deleted_at is null;
alter table public.duo_due_dates enable row level security;
revoke all on public.duo_due_dates from public, anon, authenticated;
grant select on public.duo_due_dates to authenticated;
create policy duo_due_dates_read on public.duo_due_dates for select to authenticated
  using (owner_id = (select auth.uid()) and deleted_at is null);

create function public.duo_write_due_date(
  p_action text, p_id uuid, p_key text, p_title text, p_due_on date, p_amount numeric,
  p_currency text, p_paid_on date
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then raise exception 'duo_due_date_unavailable'; end if;
  if p_action is null or p_action not in ('save', 'paid', 'delete')
    or (p_id is null and (p_action <> 'save' or p_key is null or char_length(p_key) not between 1 and 100))
    or (p_action = 'save' and (
      p_title is null or char_length(btrim(p_title)) not between 1 and 80
      or p_due_on is null or not isfinite(p_due_on)
      or (p_amount is not null and (p_amount <= 0 or p_amount > 999999999999 or p_amount <> trunc(p_amount)))
      or p_currency is null or p_currency not in ('ARS', 'USD')
    ))
    or (p_action = 'paid' and p_paid_on is not null and not isfinite(p_paid_on))
  then raise exception 'duo_invalid_due_date'; end if;

  if p_id is null then
    insert into public.duo_due_dates (owner_id, title, due_on, amount, currency, request_key)
    values (caller, btrim(p_title), p_due_on, p_amount, p_currency, p_key)
    on conflict (owner_id, request_key) do nothing;
  elsif p_action = 'save' then
    update public.duo_due_dates set title = btrim(p_title), due_on = p_due_on, amount = p_amount, currency = p_currency
    where id = p_id and owner_id = caller and deleted_at is null;
    if not found then raise exception 'duo_due_date_unavailable'; end if;
  elsif p_action = 'paid' then
    update public.duo_due_dates set paid_on = p_paid_on where id = p_id and owner_id = caller and deleted_at is null;
    if not found then raise exception 'duo_due_date_unavailable'; end if;
  else
    update public.duo_due_dates set deleted_at = coalesce(deleted_at, now()) where id = p_id and owner_id = caller;
    if not found then raise exception 'duo_due_date_unavailable'; end if;
  end if;
end;
$$;

create function public.duo_copy_due_dates(p_month date, p_ids uuid[], p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then raise exception 'duo_due_date_unavailable'; end if;
  if p_month is null or not isfinite(p_month) or extract(day from p_month) <> 1 or p_ids is null
    or p_key is null or char_length(p_key) not between 1 and 100
  then raise exception 'duo_invalid_due_date'; end if;

  insert into public.duo_due_dates (owner_id, title, due_on, amount, currency, source_id, copied_month, request_key)
  select caller, item.title,
    p_month + (least(extract(day from item.due_on)::int, (p_month + interval '1 month')::date - p_month) - 1),
    item.amount, item.currency, item.id, p_month, p_key || ':' || item.id::text
  from public.duo_due_dates item
  where item.owner_id = caller and item.id = any(p_ids) and item.deleted_at is null
    and item.due_on >= (p_month - interval '1 month')::date and item.due_on < p_month
  on conflict do nothing;
end;
$$;

revoke all on function public.duo_write_due_date(text, uuid, text, text, date, numeric, text, date)
  from public, anon, authenticated;
revoke all on function public.duo_copy_due_dates(date, uuid[], text) from public, anon, authenticated;
grant execute on function public.duo_write_due_date(text, uuid, text, text, date, numeric, text, date) to authenticated;
grant execute on function public.duo_copy_due_dates(date, uuid[], text) to authenticated;

commit;

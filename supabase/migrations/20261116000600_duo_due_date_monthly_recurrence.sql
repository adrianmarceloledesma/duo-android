begin;

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
    and table_name = 'duo_due_dates' and column_name = 'scheduled_day') then
    raise exception 'Ejecutá primero 20261116000500_duo_due_date_schedule_day.sql';
  end if;
end;
$$;

create table public.duo_due_date_schedules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.duo_profiles (user_id),
  source_id uuid not null references public.duo_due_dates (id),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  amount numeric check (amount > 0 and amount <= 999999999999 and amount = trunc(amount)),
  currency text not null check (currency in ('ARS', 'USD')),
  category text check (category ~ '^[a-z][a-z-]{0,39}$'),
  scheduled_day smallint not null check (scheduled_day between 1 and 31),
  starts_month date not null check (isfinite(starts_month) and extract(day from starts_month) = 1),
  generated_through date,
  request_key text not null,
  active boolean not null default true,
  unique (owner_id, request_key)
);

alter table public.duo_due_date_schedules enable row level security;
revoke all on public.duo_due_date_schedules from public, anon, authenticated;
grant select on public.duo_due_date_schedules to authenticated;
create policy duo_due_date_schedules_read on public.duo_due_date_schedules for select to authenticated
  using (owner_id = (select auth.uid()));

alter table public.duo_due_dates
  add column due_date_schedule_id uuid references public.duo_due_date_schedules (id);

create unique index duo_due_dates_occurrence_idx on public.duo_due_dates (due_date_schedule_id, copied_month)
  where due_date_schedule_id is not null and copied_month is not null;
create index duo_due_date_schedules_owner_active_idx on public.duo_due_date_schedules (owner_id)
  where active;

create function public.duo_generate_due_dates(p_month date) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null or p_month is null or not isfinite(p_month) or extract(day from p_month) <> 1 then
    raise exception 'duo_invalid_due_date';
  end if;

  if not exists (
    select 1 from public.duo_due_date_schedules s
    where s.owner_id = caller and s.active and s.starts_month <= p_month
      and (s.generated_through is null or s.generated_through < p_month)
  ) then return; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));
  insert into public.duo_due_dates
    (owner_id, title, due_on, amount, currency, category, scheduled_day, source_id, copied_month, due_date_schedule_id)
  select caller, s.title,
    month_start::date + (least(s.scheduled_day, (month_start + interval '1 month')::date - month_start::date) - 1),
    s.amount, s.currency, s.category, s.scheduled_day, s.source_id, month_start::date, s.id
  from public.duo_due_date_schedules s
  cross join lateral pg_catalog.generate_series(
    coalesce(s.generated_through + interval '1 month', s.starts_month::timestamp), p_month::timestamp, interval '1 month'
  ) as months(month_start)
  where s.owner_id = caller and s.active and s.starts_month <= p_month
    and (s.generated_through is null or s.generated_through < p_month)
  on conflict do nothing;

  update public.duo_due_date_schedules
  set generated_through = p_month
  where owner_id = caller and active and starts_month <= p_month
    and (generated_through is null or generated_through < p_month);
end;
$$;

create function public.duo_repeat_due_dates(p_month date, p_ids uuid[], p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  item public.duo_due_dates%rowtype;
  schedule_id uuid;
begin
  if caller is null or p_month is null or not isfinite(p_month) or extract(day from p_month) <> 1 or p_ids is null
    or p_key is null or char_length(p_key) not between 1 and 100
  then raise exception 'duo_invalid_due_date'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));
  for item in
    select d.* from public.duo_due_dates d
    where d.owner_id = caller and d.id = any(p_ids) and d.deleted_at is null
      and d.due_on >= (p_month - interval '1 month')::date and d.due_on < p_month
      and not exists (select 1 from public.duo_due_date_schedules s where s.id = d.due_date_schedule_id and s.active)
      and not exists (
        select 1 from public.duo_due_dates copy
        where copy.owner_id = caller and copy.copied_month = p_month and copy.deleted_at is null
          and (copy.source_id = d.id or copy.due_date_schedule_id = d.due_date_schedule_id)
      )
    order by d.id for update of d
  loop
    insert into public.duo_due_date_schedules
      (owner_id, source_id, title, amount, currency, category, scheduled_day, starts_month, request_key)
    values (caller, item.id, item.title, item.amount, item.currency, item.category,
      item.scheduled_day, p_month, p_key || ':' || item.id::text)
    on conflict (owner_id, request_key) do nothing returning id into schedule_id;
    if schedule_id is not null then
      update public.duo_due_dates set due_date_schedule_id = schedule_id where id = item.id;
    end if;
  end loop;
  perform public.duo_generate_due_dates(p_month);
end;
$$;

create function public.duo_stop_due_date_recurrence(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then raise exception 'duo_due_date_unavailable'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));
  update public.duo_due_date_schedules s
  set active = false
  from public.duo_due_dates d
  where d.id = p_id and d.owner_id = caller and d.deleted_at is null
    and d.due_date_schedule_id = s.id and s.owner_id = caller;
  if not found then raise exception 'duo_due_date_unavailable'; end if;
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
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));

  insert into public.duo_due_dates
    (owner_id, title, due_on, amount, currency, category, scheduled_day, source_id, copied_month, request_key)
  select caller, item.title,
    p_month + (least(item.scheduled_day, (p_month + interval '1 month')::date - p_month) - 1),
    item.amount, item.currency, item.category, item.scheduled_day, item.id, p_month, p_key || ':' || item.id::text
  from public.duo_due_dates item
  where item.owner_id = caller and item.id = any(p_ids) and item.deleted_at is null
    and item.due_on >= (p_month - interval '1 month')::date and item.due_on < p_month
    and not exists (select 1 from public.duo_due_date_schedules s where s.id = item.due_date_schedule_id and s.active)
    and not exists (
      select 1 from public.duo_due_dates copy
      where copy.owner_id = caller and copy.copied_month = p_month and copy.deleted_at is null
        and copy.due_date_schedule_id = item.due_date_schedule_id
    )
  on conflict do nothing;
end;
$$;

revoke all on function public.duo_generate_due_dates(date), public.duo_repeat_due_dates(date, uuid[], text),
  public.duo_stop_due_date_recurrence(uuid) from public, anon, authenticated;
grant execute on function public.duo_generate_due_dates(date), public.duo_repeat_due_dates(date, uuid[], text),
  public.duo_stop_due_date_recurrence(uuid) to authenticated;

commit;

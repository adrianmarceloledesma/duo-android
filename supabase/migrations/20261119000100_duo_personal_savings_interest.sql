begin;

create table if not exists public.duo_personal_savings_interest (
  owner_id uuid primary key references public.duo_profiles(user_id),
  annual_percent numeric not null check (annual_percent between 0 and 1000 and annual_percent = round(annual_percent, 4)),
  starts_on date not null,
  settled_through date not null,
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.duo_personal_savings_interest enable row level security;
revoke all on public.duo_personal_savings_interest from public, anon, authenticated;
grant select on public.duo_personal_savings_interest to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'duo_personal_savings_interest' and policyname = 'duo_personal_interest_owner') then
    create policy duo_personal_interest_owner on public.duo_personal_savings_interest for select to authenticated
    using (owner_id = (select auth.uid()));
  end if;
end $$;

alter table public.duo_movements
  add column if not exists savings_interest_on date,
  add column if not exists savings_interest_tna numeric;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.duo_movements'::regclass and conname = 'duo_personal_interest_movement') then
    alter table public.duo_movements add constraint duo_personal_interest_movement check (
    (savings_interest_on is null and savings_interest_tna is null) or
    (savings_interest_on is not null and savings_interest_tna is not null and savings_interest_tna > 0 and savings_interest_tna <= 1000
      and kind = 'saving' and currency = 'ARS' and pair_id is null and recipient_id is null
      and saving_kind = 'deposit' and exclude_from_monthly_cash)
    );
  end if;
end $$;
create unique index if not exists duo_personal_interest_one_day on public.duo_movements(owner_id, savings_interest_on)
where savings_interest_on is not null;

-- Internal clock parameter makes deterministic isolated tests possible. Never executable by app roles.
create or replace function public.duo_settle_personal_interest(p_owner uuid, p_today date) returns void
language plpgsql security definer set search_path = '' as $$
declare
  config public.duo_personal_savings_interest%rowtype;
  day date;
  balance numeric;
  earned numeric;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text, 0));
  select * into config from public.duo_personal_savings_interest where owner_id = p_owner for update;
  if not found or config.settled_through >= p_today - 1 then return; end if;
  if config.annual_percent > 0 then
    day := config.settled_through + 1;
    while day < p_today loop
      select greatest(coalesce(sum(case when saving_kind = 'deposit' then amount else -amount end), 0), 0)
      into balance from public.duo_movements
      where owner_id = p_owner and kind = 'saving' and currency = 'ARS' and pair_id is null
        and deleted_at is null and movement_date <= day;
      earned := round(balance * config.annual_percent / 36500, 2);
      if earned > 0 then
        insert into public.duo_movements (owner_id, pair_id, recipient_id, request_key, movement_date, kind, amount,
          currency, category, note, saving_kind, exclude_from_monthly_cash, savings_interest_on, savings_interest_tna)
        values (p_owner, null, null, 'personal-interest:' || day::text, day, 'saving', earned, 'ARS', null,
          'Rendimiento calculado · ' || config.annual_percent::text || '% anual', 'deposit', true, day, config.annual_percent)
        on conflict (owner_id, request_key) do nothing;
      end if;
      day := day + 1;
    end loop;
  end if;
  update public.duo_personal_savings_interest set settled_through = p_today - 1 where owner_id = p_owner;
end;
$$;

create or replace function public.duo_personal_interest_status() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  today date := (clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date;
  config public.duo_personal_savings_interest%rowtype;
begin
  if caller is null or not exists (select 1 from public.duo_profiles where user_id = caller) then raise exception 'duo_profile_required'; end if;
  perform public.duo_settle_personal_interest(caller, today);
  select * into config from public.duo_personal_savings_interest where owner_id = caller;
  return jsonb_build_object('annual_percent', coalesce(config.annual_percent, 0),
    'starts_on', coalesce(config.starts_on, today), 'settled_through', coalesce(config.settled_through, today - 1));
end;
$$;

create or replace function public.duo_set_personal_interest(p_annual_percent numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  today date := (clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  if caller is null or not exists (select 1 from public.duo_profiles where user_id = caller) then raise exception 'duo_profile_required'; end if;
  if p_annual_percent is null or p_annual_percent < 0 or p_annual_percent > 1000 or p_annual_percent <> round(p_annual_percent, 4) then
    raise exception 'duo_invalid_interest_rate';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));
  perform public.duo_settle_personal_interest(caller, today);
  insert into public.duo_personal_savings_interest(owner_id, annual_percent, starts_on, settled_through)
  values (caller, p_annual_percent, today, today - 1)
  on conflict (owner_id) do update set annual_percent = excluded.annual_percent, updated_at = clock_timestamp();
end;
$$;

create or replace function public.duo_settle_all_personal_interest() returns void
language plpgsql security definer set search_path = '' as $$
declare
  person record;
  today date := (clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  for person in select owner_id from public.duo_personal_savings_interest where annual_percent > 0 order by owner_id loop
    perform public.duo_settle_personal_interest(person.owner_id, today);
  end loop;
end;
$$;

revoke all on function public.duo_settle_personal_interest(uuid, date), public.duo_settle_all_personal_interest(),
  public.duo_personal_interest_status(), public.duo_set_personal_interest(numeric) from public, anon, authenticated;
grant execute on function public.duo_personal_interest_status(), public.duo_set_personal_interest(numeric) to authenticated;

notify pgrst, 'reload schema';
commit;

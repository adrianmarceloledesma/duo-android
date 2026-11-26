begin;

create table if not exists public.duo_shared_savings_interest (
  pair_id uuid primary key references public.duo_pairs(id) on delete cascade,
  annual_percent numeric not null check (annual_percent between 0 and 1000 and annual_percent = round(annual_percent, 4)),
  starts_on date not null,
  settled_through date not null,
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.duo_shared_savings_interest enable row level security;
revoke all on public.duo_shared_savings_interest from public, anon, authenticated;
grant select on public.duo_shared_savings_interest to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'duo_shared_savings_interest' and policyname = 'duo_shared_interest_members') then
    create policy duo_shared_interest_members on public.duo_shared_savings_interest for select to authenticated
    using (pair_id = (select public.duo_current_pair()));
  end if;
end $$;

-- Extend the existing interest invariant without changing amounts, dates or financial records.
alter table public.duo_movements drop constraint if exists duo_personal_interest_movement;
alter table public.duo_movements add constraint duo_personal_interest_movement check (
  (savings_interest_on is null and savings_interest_tna is null) or
  (savings_interest_on is not null and savings_interest_tna is not null and savings_interest_tna > 0 and savings_interest_tna <= 1000
    and kind = 'saving' and currency = 'ARS' and recipient_id is null
    and saving_kind = 'deposit' and exclude_from_monthly_cash)
);
-- Personal and shared credits may occur on the same day. A shared day belongs to the pair, not each member.
drop index if exists public.duo_personal_interest_one_day;
create unique index duo_personal_interest_one_day on public.duo_movements(owner_id, savings_interest_on)
  where savings_interest_on is not null and pair_id is null;
create unique index if not exists duo_shared_interest_one_day on public.duo_movements(pair_id, savings_interest_on)
  where savings_interest_on is not null and pair_id is not null;

create or replace function public.duo_settle_shared_interest(p_pair uuid, p_today date) returns void
language plpgsql security definer set search_path = '' as $$
declare
  config public.duo_shared_savings_interest%rowtype;
  day date;
  balance numeric;
  earned numeric;
  credit_owner uuid;
begin
  -- Match the pair lock used by deposits, withdrawals and edits. Never acquire an owner lock after it.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_pair::text, 1));
  select * into config from public.duo_shared_savings_interest where pair_id = p_pair for update;
  if not found or config.settled_through >= p_today - 1 then return; end if;
  select user_id into credit_owner from public.duo_pair_members where pair_id = p_pair order by seat limit 1;
  if credit_owner is null then return; end if;
  if config.annual_percent > 0 then
    day := config.settled_through + 1;
    while day < p_today loop
      select greatest(coalesce(sum(case when saving_kind = 'deposit' then amount else -amount end), 0), 0)
        into balance from public.duo_movements
        where pair_id = p_pair and kind = 'saving' and currency = 'ARS' and deleted_at is null and movement_date <= day;
      earned := round(balance * config.annual_percent / 36500, 2);
      if earned > 0 then
        insert into public.duo_movements (owner_id, pair_id, recipient_id, request_key, movement_date, kind, amount,
          currency, category, note, saving_kind, exclude_from_monthly_cash, savings_interest_on, savings_interest_tna)
        values (credit_owner, p_pair, null, 'shared-interest:' || p_pair::text || ':' || day::text, day, 'saving', earned, 'ARS', null,
          'Rendimiento calculado · ' || config.annual_percent::text || '% anual', 'deposit', true, day, config.annual_percent)
        on conflict do nothing;
      end if;
      day := day + 1;
    end loop;
  end if;
  update public.duo_shared_savings_interest set settled_through = p_today - 1 where pair_id = p_pair;
end;
$$;

create or replace function public.duo_shared_interest_status() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  current_pair uuid := public.duo_current_pair();
  today date := (clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date;
  config public.duo_shared_savings_interest%rowtype;
begin
  if caller is null then raise exception 'duo_profile_required'; end if;
  if current_pair is null then return null; end if;
  perform public.duo_settle_shared_interest(current_pair, today);
  select * into config from public.duo_shared_savings_interest where pair_id = current_pair;
  return jsonb_build_object('annual_percent', coalesce(config.annual_percent, 0),
    'starts_on', coalesce(config.starts_on, today), 'settled_through', coalesce(config.settled_through, today - 1));
end;
$$;

create or replace function public.duo_set_shared_interest(p_annual_percent numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  current_pair uuid := public.duo_current_pair();
  today date := (clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  if caller is null then raise exception 'duo_profile_required'; end if;
  if current_pair is null or (select count(*) from public.duo_pair_members where pair_id = current_pair) <> 2 then
    raise exception 'duo_link_required';
  end if;
  if p_annual_percent is null or p_annual_percent < 0 or p_annual_percent > 1000 or p_annual_percent <> round(p_annual_percent, 4) then
    raise exception 'duo_invalid_interest_rate';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(current_pair::text, 1));
  perform public.duo_settle_shared_interest(current_pair, today);
  insert into public.duo_shared_savings_interest(pair_id, annual_percent, starts_on, settled_through)
    values (current_pair, p_annual_percent, today, today - 1)
    on conflict (pair_id) do update set annual_percent = excluded.annual_percent, updated_at = clock_timestamp();
end;
$$;

create or replace function public.duo_settle_all_shared_interest() returns void
language plpgsql security definer set search_path = '' as $$
declare
  account record;
  today date := (clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  for account in select pair_id from public.duo_shared_savings_interest where annual_percent > 0 order by pair_id loop
    perform public.duo_settle_shared_interest(account.pair_id, today);
  end loop;
end;
$$;

revoke all on function public.duo_settle_shared_interest(uuid, date), public.duo_settle_all_shared_interest(),
  public.duo_shared_interest_status(), public.duo_set_shared_interest(numeric) from public, anon, authenticated;
grant execute on function public.duo_shared_interest_status(), public.duo_set_shared_interest(numeric) to authenticated;

notify pgrst, 'reload schema';
commit;

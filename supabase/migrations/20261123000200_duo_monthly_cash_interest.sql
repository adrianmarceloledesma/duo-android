begin;

create table if not exists public.duo_cash_interest (
  owner_id uuid primary key references public.duo_profiles(user_id),
  annual_percent numeric not null check (annual_percent between 0 and 1000 and annual_percent = round(annual_percent, 4)),
  starts_on date not null,
  settled_through date not null,
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.duo_cash_interest enable row level security;
revoke all on public.duo_cash_interest from public, anon, authenticated;
grant select on public.duo_cash_interest to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='duo_cash_interest' and policyname='duo_cash_interest_owner') then
    create policy duo_cash_interest_owner on public.duo_cash_interest for select to authenticated using (owner_id=(select auth.uid()));
  end if;
end $$;

alter table public.duo_movements add column if not exists cash_interest_on date, add column if not exists cash_interest_tna numeric;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.duo_movements'::regclass and conname='duo_cash_interest_income') then
    alter table public.duo_movements add constraint duo_cash_interest_income check (
      (cash_interest_on is null and cash_interest_tna is null) or
      (cash_interest_on is not null and cash_interest_tna is not null and cash_interest_tna > 0 and cash_interest_tna <= 1000
        and kind='income' and currency='ARS' and pair_id is null and recipient_id is null and category is null and saving_kind is null)
    );
  end if;
end $$;
create unique index if not exists duo_cash_interest_one_day on public.duo_movements(owner_id,cash_interest_on) where cash_interest_on is not null;

-- App roles never supply the clock or target user. The worker is private.
create or replace function public.duo_settle_cash_interest(p_owner uuid, p_today date) returns void
language plpgsql security definer set search_path = '' as $$
declare
  config public.duo_cash_interest%rowtype;
  current_pair uuid;
  day date;
  balance numeric;
  earned numeric;
begin
  -- Same owner -> pair order as financial writes, including transfers affecting this available balance.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text,0));
  select pair_id into current_pair from public.duo_pair_members where user_id=p_owner;
  if current_pair is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(current_pair::text,1));
  end if;
  select * into config from public.duo_cash_interest where owner_id=p_owner for update;
  if not found or config.settled_through >= p_today-1 then return; end if;
  if config.annual_percent > 0 then
    day := config.settled_through+1;
    while day < p_today loop
      -- Mirror getMonthlyCash: only this month, only movements dated through the closed day.
      select greatest(coalesce(sum(case
        when kind='income' and owner_id=p_owner then amount
        when kind='expense' and owner_id=p_owner then -amount
        when kind='transfer' and recipient_id=p_owner then amount
        when kind='transfer' and owner_id=p_owner then -amount
        when kind='saving' and owner_id=p_owner and saving_kind='withdraw' then amount
        when kind='saving' and owner_id=p_owner and saving_kind='deposit' and not coalesce(exclude_from_monthly_cash,false) then -amount
        else 0 end),0),0)
      into balance from public.duo_movements
      where deleted_at is null and currency='ARS' and movement_date >= date_trunc('month',day)::date and movement_date <= day
        and (owner_id=p_owner or recipient_id=p_owner);
      earned := round(balance*config.annual_percent/36500,2);
      if earned > 0 then
        insert into public.duo_movements(owner_id,pair_id,recipient_id,request_key,movement_date,kind,amount,currency,category,note,saving_kind,cash_interest_on,cash_interest_tna)
        values(p_owner,null,null,'cash-interest:'||day::text,day,'income',earned,'ARS',null,
          'Rendimiento del disponible · '||config.annual_percent::text||'% anual',null,day,config.annual_percent)
        on conflict do nothing;
      end if;
      day := day+1;
    end loop;
  end if;
  update public.duo_cash_interest set settled_through=p_today-1 where owner_id=p_owner;
end;
$$;

create or replace function public.duo_cash_interest_status() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  today date := (clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date;
  config public.duo_cash_interest%rowtype;
begin
  if caller is null or not exists(select 1 from public.duo_profiles where user_id=caller) then raise exception 'duo_profile_required'; end if;
  perform public.duo_settle_cash_interest(caller,today);
  select * into config from public.duo_cash_interest where owner_id=caller;
  return jsonb_build_object('annual_percent',coalesce(config.annual_percent,0),'starts_on',coalesce(config.starts_on,today),'settled_through',coalesce(config.settled_through,today-1));
end;
$$;

create or replace function public.duo_set_cash_interest(p_annual_percent numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  today date := (clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  if caller is null or not exists(select 1 from public.duo_profiles where user_id=caller) then raise exception 'duo_profile_required'; end if;
  if p_annual_percent is null or p_annual_percent < 0 or p_annual_percent > 1000 or p_annual_percent <> round(p_annual_percent,4) then raise exception 'duo_invalid_interest_rate'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text,0));
  perform public.duo_settle_cash_interest(caller,today);
  insert into public.duo_cash_interest(owner_id,annual_percent,starts_on,settled_through) values(caller,p_annual_percent,today,today-1)
    on conflict(owner_id) do update set annual_percent=excluded.annual_percent,updated_at=clock_timestamp();
end;
$$;

create or replace function public.duo_settle_all_cash_interest() returns void
language plpgsql security definer set search_path = '' as $$
declare
  person record;
  today date := (clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  for person in select owner_id from public.duo_cash_interest where annual_percent>0 order by owner_id loop
    perform public.duo_settle_cash_interest(person.owner_id,today);
  end loop;
end;
$$;
revoke all on function public.duo_settle_cash_interest(uuid,date),public.duo_settle_all_cash_interest(),public.duo_cash_interest_status(),public.duo_set_cash_interest(numeric) from public,anon,authenticated;
grant execute on function public.duo_cash_interest_status(),public.duo_set_cash_interest(numeric) to authenticated;
notify pgrst,'reload schema';
commit;

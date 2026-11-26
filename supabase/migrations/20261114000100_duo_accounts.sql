begin;

create table public.duo_profiles (
  user_id uuid primary key references auth.users (id),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60)
);

create table public.duo_pairs (
  id uuid primary key default gen_random_uuid()
);

create table public.duo_pair_members (
  user_id uuid primary key references public.duo_profiles (user_id),
  pair_id uuid not null references public.duo_pairs (id) on delete cascade,
  seat smallint not null check (seat in (1, 2)),
  unique (pair_id, seat)
);

create table public.duo_invites (
  pair_id uuid primary key references public.duo_pairs (id) on delete cascade,
  code uuid not null unique default gen_random_uuid(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create table public.duo_movements (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.duo_profiles (user_id),
  pair_id uuid references public.duo_pairs (id),
  recipient_id uuid references public.duo_profiles (user_id),
  request_key text not null,
  movement_date date not null,
  kind text not null,
  amount numeric not null check (amount > 0 and amount <= 999999999999 and amount = round(amount, 2)),
  currency text not null check (currency in ('ARS', 'USD')),
  category text check (category ~ '^[a-z][a-z-]{0,39}$'),
  note text not null check (char_length(note) <= 500),
  saving_kind text check (saving_kind in ('deposit', 'withdraw')),
  unique (owner_id, request_key),
  check (
    (kind = 'expense' and category is not null and saving_kind is null and recipient_id is null and currency = 'ARS' and amount = trunc(amount)) or
    (kind = 'income' and category is null and saving_kind is null and recipient_id is null and pair_id is null and currency = 'ARS') or
    (kind = 'saving' and category is null and saving_kind is not null and recipient_id is null) or
    (kind = 'transfer' and category is null and saving_kind is null and recipient_id is not null and recipient_id <> owner_id and pair_id is not null and currency = 'ARS')
  )
);

create index duo_movements_pair_idx on public.duo_movements (pair_id) where pair_id is not null;

alter table public.duo_profiles enable row level security;
alter table public.duo_pairs enable row level security;
alter table public.duo_pair_members enable row level security;
alter table public.duo_invites enable row level security;
alter table public.duo_movements enable row level security;

revoke all on public.duo_profiles, public.duo_pairs, public.duo_pair_members, public.duo_invites,
  public.duo_movements from public, anon, authenticated;
grant select, insert, update on public.duo_profiles to authenticated;
grant select on public.duo_movements to authenticated;

create policy duo_profile_read on public.duo_profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy duo_profile_create on public.duo_profiles for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy duo_profile_change on public.duo_profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create function public.duo_current_pair() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.pair_id from public.duo_pair_members m where m.user_id = auth.uid()
$$;

create policy duo_movement_read on public.duo_movements for select to authenticated
  using (owner_id = (select auth.uid()) or pair_id = (select public.duo_current_pair()));

create function public.duo_partner() returns table (user_id uuid, display_name text)
language sql stable security definer set search_path = '' as $$
  select p.user_id, p.display_name
  from public.duo_pair_members m
  join public.duo_profiles p on p.user_id = m.user_id
  where m.pair_id = public.duo_current_pair() and m.user_id <> auth.uid()
$$;

create function public.duo_create_invite() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  current_pair uuid;
  invite_code uuid;
begin
  if not exists (select 1 from public.duo_profiles p where p.user_id = caller) then
    raise exception 'duo_profile_required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(429413329);
  current_pair := public.duo_current_pair();
  if current_pair is null then
    insert into public.duo_pairs default values returning id into current_pair;
    insert into public.duo_pair_members (user_id, pair_id, seat) values (caller, current_pair, 1);
  elsif exists (select 1 from public.duo_pair_members m where m.pair_id = current_pair and m.user_id <> caller) then
    raise exception 'duo_already_linked';
  end if;

  select i.code into invite_code
  from public.duo_invites i where i.pair_id = current_pair and i.expires_at > now();
  if invite_code is not null then
    return invite_code;
  end if;

  insert into public.duo_invites (pair_id) values (current_pair)
  on conflict (pair_id) do update set code = gen_random_uuid(), expires_at = now() + interval '24 hours'
  returning code into invite_code;
  return invite_code;
end;
$$;

create function public.duo_accept_invite(invite_code uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  target_pair uuid;
  current_pair uuid;
begin
  if not exists (select 1 from public.duo_profiles p where p.user_id = caller) then
    raise exception 'duo_profile_required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(429413329);
  select i.pair_id into target_pair from public.duo_invites i
    where i.code = invite_code and i.expires_at > now();
  if target_pair is null then
    raise exception 'duo_invalid_invite';
  end if;

  current_pair := public.duo_current_pair();
  if current_pair = target_pair then
    raise exception 'duo_own_invite';
  end if;
  if current_pair is not null then
    if exists (select 1 from public.duo_pair_members m where m.pair_id = current_pair and m.user_id <> caller) then
      raise exception 'duo_already_linked';
    end if;
    delete from public.duo_pairs where id = current_pair;
  end if;

  insert into public.duo_pair_members (user_id, pair_id, seat) values (caller, target_pair, 2);
  delete from public.duo_invites where pair_id = target_pair;
end;
$$;

create function public.duo_add_movement(
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
    where m.pair_id = current_pair and m.kind in ('expense', 'transfer');
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

revoke all on function public.duo_current_pair(), public.duo_partner(), public.duo_create_invite(),
  public.duo_accept_invite(uuid), public.duo_add_movement(text, text, numeric, date, boolean, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.duo_current_pair(), public.duo_partner(), public.duo_create_invite(),
  public.duo_accept_invite(uuid), public.duo_add_movement(text, text, numeric, date, boolean, text, text, text, text)
  to authenticated;

commit;

begin;

create table public.duo_google_accounts (
  email text primary key check (email = lower(btrim(email)) and email <> '')
);
alter table public.duo_google_accounts enable row level security;
revoke all on public.duo_google_accounts from public, anon, authenticated;
grant select on public.duo_google_accounts to supabase_auth_admin;
create policy duo_auth_read_google_accounts on public.duo_google_accounts
  for select to supabase_auth_admin using (true);

create function public.duo_before_user_created(event jsonb) returns jsonb
language sql stable set search_path = '' as $$
  select case when (event #>> '{user,app_metadata,provider}') = 'google'
    and exists (
      select 1 from public.duo_google_accounts a
      where a.email = lower(btrim(event #>> '{user,email}'))
    )
  then '{}'::jsonb
  else jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', 'This account is not authorized to join Duo.'
  ))
  end
$$;

revoke all on function public.duo_before_user_created(jsonb) from public, anon, authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.duo_before_user_created(jsonb) to supabase_auth_admin;

commit;

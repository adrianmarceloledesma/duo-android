begin;

-- Google OAuth is validated by Supabase before this server-only hook runs.
-- The initial list of two authorized emails is no longer required for signups.
-- Personal/group RLS, memberships and existing users are intentionally untouched.
create or replace function public.duo_before_user_created(event jsonb) returns jsonb
language sql stable set search_path = '' as $$
  select case
    when (event #>> '{user,app_metadata,provider}') = 'google'
      and nullif(btrim(event #>> '{user,email}'), '') is not null
      and coalesce(event #>> '{user,is_anonymous}', 'false') <> 'true'
    then '{}'::jsonb
    else jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'Para crear tu cuenta en Duo, continuá con Google.'
    ))
  end
$$;

revoke all on function public.duo_before_user_created(jsonb) from public, anon, authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.duo_before_user_created(jsonb) to supabase_auth_admin;
comment on function public.duo_before_user_created(jsonb) is 'Registro abierto con Google; no permite altas por contraseña ni anónimas. No cambia permisos de los datos.';
notify pgrst, 'reload schema';
commit;

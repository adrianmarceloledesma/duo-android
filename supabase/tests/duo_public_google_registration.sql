begin;
set local plpgsql.check_asserts=on;
set local role supabase_auth_admin;
do $$ begin
  assert public.duo_before_user_created('{"user":{"email":"new-person@example.invalid","app_metadata":{"provider":"google"}}}'::jsonb) = '{}'::jsonb, 'New Google account was blocked by the old allowlist';
  assert public.duo_before_user_created('{"user":{"email":"another-person@example.invalid","app_metadata":{"provider":"google"}}}'::jsonb) = '{}'::jsonb;
  assert (public.duo_before_user_created('{"user":{"email":"x@example.invalid","app_metadata":{"provider":"email"}}}'::jsonb)->'error'->>'http_code')::int=403;
  assert public.duo_before_user_created('{"user":{"email":"x@example.invalid","user_metadata":{"provider":"google"},"app_metadata":{"provider":"email"}}}'::jsonb) ? 'error', 'User metadata bypassed provider validation';
  assert public.duo_before_user_created('{"user":{"email":"x@example.invalid","app_metadata":{"provider":"google"},"is_anonymous":true}}'::jsonb) ? 'error';
  assert public.duo_before_user_created('{"user":{"email":" ","app_metadata":{"provider":"google"}}}'::jsonb) ? 'error';
  assert public.duo_before_user_created('{}'::jsonb) ? 'error';
  assert public.duo_before_user_created(null) ? 'error';
end $$;
reset role;
set local role authenticated;
do $$ begin
  assert not has_function_privilege('public.duo_before_user_created(jsonb)','execute');
  assert not has_table_privilege('public.duo_google_accounts','select');
  assert not has_table_privilege('public.duo_movements','insert');
end $$;
reset role;
set local role anon;
do $$ begin assert not has_function_privilege('public.duo_before_user_created(jsonb)','execute'); end $$;
rollback;

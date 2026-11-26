begin;
set local plpgsql.check_asserts = on;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'expense-push-marce@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'expense-push-mel@example.invalid');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
insert into public.duo_profiles values (auth.uid(), 'Marce');
select set_config('duo.shared_push_invite', public.duo_create_invite()::text, true);
select public.duo_set_push_preferences('00000000-0000-4000-8000-000000000101', 'ExponentPushToken[SharedMarce-Test]', false, true);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
insert into public.duo_profiles values (auth.uid(), 'Mel');
select public.duo_accept_invite(current_setting('duo.shared_push_invite')::uuid);
select public.duo_set_push_preferences('00000000-0000-4000-8000-000000000102', 'ExponentPushToken[SharedMel-Test]', true, true);
select public.duo_add_movement('mel-expense', 'expense', 100, date '2026-11-18', true, 'ARS', 'supermercado', 'Private test amount', null);
select public.duo_add_movement('mel-expense', 'expense', 100, date '2026-11-18', true, 'ARS', 'supermercado', 'Private test amount', null);
select public.duo_add_movement('mel-private', 'expense', 200, date '2026-11-18', false, 'ARS', 'sube', 'Private test expense', null);
select public.duo_save_debt_receivable('no-debt-alert', null, false, 100, date '2026-11-18', 'Private test debt');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.duo_add_movement('marce-expense', 'expense-usd', 100, date '2026-11-18', true, 'USD', 'otros', 'Private test description', null);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
select public.duo_set_push_preferences('00000000-0000-4000-8000-000000000102', 'ExponentPushToken[SharedMel-Test]', true, false);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.duo_add_movement('no-expense-alert', 'expense', 100, date '2026-11-18', true, 'ARS', 'supermercado', '', null);
select public.duo_save_debt_receivable('yes-debt-alert', null, false, 100, date '2026-11-18', 'Private test debt');
select public.duo_set_push_preferences('00000000-0000-4000-8000-000000000101', null, false, false);

reset role;
do $$
declare
  traffic jsonb[];
begin
  select array_agg(convert_from(body, 'UTF8')::jsonb) into traffic from net.http_request_queue
  where url = 'https://exp.host/--/api/v2/push/send' and convert_from(body, 'UTF8') like '%Shared%Test]%';
  assert cardinality(traffic) = 3;
  assert exists (select 1 from unnest(traffic) n where n->>'title' = 'Nuevo gasto compartido'
    and n->'to' = '["ExponentPushToken[SharedMarce-Test]"]'::jsonb);
  assert exists (select 1 from unnest(traffic) n where n->>'title' = 'Nuevo gasto compartido'
    and n->'to' = '["ExponentPushToken[SharedMel-Test]"]'::jsonb);
  assert exists (select 1 from unnest(traffic) n where n->>'title' = 'Nueva deuda registrada'
    and n->'to' = '["ExponentPushToken[SharedMel-Test]"]'::jsonb);
  assert not exists (select 1 from unnest(traffic) n where n::text like '%Private test%');
  assert not exists (select 1 from public.duo_push_devices where expo_token = 'ExponentPushToken[SharedMarce-Test]');
end;
$$;

rollback;

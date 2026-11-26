begin;
set local plpgsql.check_asserts = on;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'push-marce@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'push-mel@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
insert into public.duo_profiles values (auth.uid(), 'Marce');
select set_config('duo.push_invite', public.duo_create_invite()::text, true);
select public.duo_set_push_device('00000000-0000-4000-8000-000000000101', 'ExponentPushToken[DuoMarce-Test]');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
insert into public.duo_profiles values (auth.uid(), 'Mel');
select public.duo_accept_invite(current_setting('duo.push_invite')::uuid);
select public.duo_set_push_device('00000000-0000-4000-8000-000000000102', 'ExponentPushToken[DuoMel-Test]');
select public.duo_save_debt_receivable('car', null, false, 200, date '2026-11-17', 'Personal description');
select public.duo_save_debt_receivable('car', null, false, 200, date '2026-11-17', 'Personal description');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.duo_add_movement('private', 'expense', 300, date '2026-11-17', false, 'ARS', 'sube', '', null);
select public.duo_add_movement('shared', 'expense', 500, date '2026-11-17', true, 'ARS', 'supermercado', '', null);
select public.duo_add_movement('payment', 'transfer-usd', 100, date '2026-11-17', false, 'USD', null, '', null);
select public.duo_set_push_device('00000000-0000-4000-8000-000000000101', null);
do $$ begin
  assert not has_table_privilege('public.duo_push_devices', 'select');
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
select public.duo_save_debt_receivable('disconnected', null, false, 500, date '2026-11-17', 'Other debt');
reset role;

do $$
declare
  traffic jsonb[];
begin
  select array_agg(convert_from(body, 'UTF8')::jsonb) into traffic
  from net.http_request_queue
  where url = 'https://exp.host/--/api/v2/push/send'
    and convert_from(body, 'UTF8') like '%Duo%Test]%';
  assert cardinality(traffic) = 2;
  assert exists (select 1 from unnest(traffic) as notice where notice->>'title' = 'Nueva deuda registrada'
    and notice->'to' = '["ExponentPushToken[DuoMarce-Test]"]'::jsonb);
  assert exists (select 1 from unnest(traffic) as notice where notice->>'title' = 'Pago de deuda registrado'
    and notice->'to' = '["ExponentPushToken[DuoMel-Test]"]'::jsonb);
  assert not exists (select 1 from unnest(traffic) as notice where notice::text like '%Personal description%');
end;
$$;

rollback;

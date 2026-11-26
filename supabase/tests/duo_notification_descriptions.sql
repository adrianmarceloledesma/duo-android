begin;
set local plpgsql.check_asserts = on;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'detail-marce@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'detail-mel@example.invalid');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
insert into public.duo_profiles values (auth.uid(), 'Marce');
select set_config('duo.detail_invite', public.duo_create_invite()::text, true);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
insert into public.duo_profiles values (auth.uid(), 'Mel');
select public.duo_accept_invite(current_setting('duo.detail_invite')::uuid);
select public.duo_set_push_preferences('00000000-0000-4000-8000-000000000102', 'ExponentPushToken[DetailOptIn-Test]', true, true, true);
select public.duo_set_push_preferences('00000000-0000-4000-8000-000000000103', 'ExponentPushToken[DetailLegacy-Test]', true, true);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.duo_add_movement('detail', 'expense', 100, date '2026-11-18', true, 'ARS', 'supermercado', E'   Pan y\nleche  ', null);
select public.duo_add_movement('blank', 'expense', 100, date '2026-11-18', true, 'ARS', 'supermercado', ' ', null);
select public.duo_add_movement('usd-details', 'expense-usd', 1234, date '2026-11-18', true, 'USD', 'luz', '', null);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
select public.duo_set_push_preferences('00000000-0000-4000-8000-000000000102', 'ExponentPushToken[DetailOptIn-Test]', true, true, false);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.duo_save_debt_receivable('after-opt-out', null, false, 100, date '2026-11-18', 'Should not appear');

reset role;
do $$
declare
  traffic jsonb[];
begin
  select array_agg(convert_from(body, 'UTF8')::jsonb) into traffic from net.http_request_queue
  where url = 'https://exp.host/--/api/v2/push/send' and convert_from(body, 'UTF8') like '%Detail%Test]%';
  assert cardinality(traffic) = 7;
  assert exists (select 1 from unnest(traffic) n where n->>'body' = '$ 100 · Supermercado · Pan y leche'
    and n->'to' = '["ExponentPushToken[DetailOptIn-Test]"]'::jsonb);
  assert exists (select 1 from unnest(traffic) n where n->>'body' = 'Abrí Duo para ver el movimiento.'
    and n->'to' = '["ExponentPushToken[DetailLegacy-Test]"]'::jsonb);
  assert exists (select 1 from unnest(traffic) n where n->>'title' = 'Nuevo gasto compartido'
    and n->>'body' = '$ 100 · Supermercado' and n->'to' = '["ExponentPushToken[DetailOptIn-Test]"]'::jsonb);
  assert exists (select 1 from unnest(traffic) n where n->>'title' = 'Nueva deuda registrada'
    and n->>'body' = 'Abrí Duo para ver el movimiento.' and jsonb_array_length(n->'to') = 2);
  assert not exists (select 1 from unnest(traffic) n where n::text like '%Should not appear%');
  assert exists (select 1 from unnest(traffic) n where n->>'body' = 'US$ 1.234 · Edesur'
    and n->'to' = '["ExponentPushToken[DetailOptIn-Test]"]'::jsonb);
  assert not exists (select 1 from unnest(traffic) n where n->>'body' like '%US$%'
    and n->'to' @> '["ExponentPushToken[DetailLegacy-Test]"]'::jsonb);
end;
$$;

rollback;

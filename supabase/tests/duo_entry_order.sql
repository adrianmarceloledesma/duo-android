begin;
set local plpgsql.check_asserts = on;
insert into auth.users (id, email) values ('30000000-0000-4000-8000-000000000001', 'order-test@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000001', true);
insert into public.duo_profiles values (auth.uid(), 'Order test');
select public.duo_add_movement('order-current', 'expense', 100, '2026-11-18', false, 'ARS', 'supermercado', 'Primero', null);
select public.duo_add_movement('order-backdated', 'expense', 200, '2020-01-01', false, 'ARS', 'supermercado', 'Último', null);
select set_config('test.order_id', (select id::text from public.duo_movements where request_key = 'order-backdated'), true);
select set_config('test.order_timestamp', (select created_at::text from public.duo_movements where request_key = 'order-backdated'), true);
do $$ begin
  assert (select bool_and(created_at is not null) from public.duo_movements), 'A creation timestamp was not saved';
  assert (select created_at from public.duo_movements where request_key = 'order-backdated') >=
    (select created_at from public.duo_movements where request_key = 'order-current');
  assert (select movement_date from public.duo_movements where request_key = 'order-backdated') = '2020-01-01';
end $$;
select public.duo_change_expense_currency(current_setting('test.order_id')::uuid, false, 350, 'luz', 'Editado', '2027-01-01', false, 'ARS');
select public.duo_add_movement('order-backdated', 'expense', 200, '2020-01-01', false, 'ARS', 'supermercado', 'Reintento', null);
do $$ begin
  assert (select count(*) from public.duo_movements) = 2;
  assert (select created_at from public.duo_movements where request_key = 'order-backdated') = current_setting('test.order_timestamp')::timestamptz;
  assert (select amount from public.duo_movements where request_key = 'order-backdated') = 350;
  assert (select movement_date from public.duo_movements where request_key = 'order-backdated') = '2027-01-01';
  assert not has_function_privilege('public.duo_movement_recorded_at(text)', 'execute');
end $$;
reset role;
do $$ begin
  assert public.duo_movement_recorded_at('1795032360000-ab123-1795032360000-cd456') = to_timestamp(1795032360);
  assert public.duo_movement_recorded_at('invalid-key') is null;
  assert public.duo_movement_recorded_at('9999999999999-test') is null;
  assert public.duo_notification_amount(25000, 'ARS') = '$ 25.000';
  assert public.duo_notification_amount(1234.5, 'USD') = 'US$ 1.234,50';
  assert public.duo_notification_category('luz') = 'Edesur';
  assert public.duo_notification_category('gas') = 'Metrogas';
  assert public.duo_notification_category('voley') = 'Vóley';
end $$;
rollback;

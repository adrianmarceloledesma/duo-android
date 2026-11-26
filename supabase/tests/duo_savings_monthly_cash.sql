begin;
set local plpgsql.check_asserts = on;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'duo-savings-marce@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'duo-savings-mel@example.invalid');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
insert into public.duo_profiles values (auth.uid(), 'Marce');
select public.duo_add_saving_without_cash('prior-ars', 200000, date '2026-11-15', false, 'Ya ahorrado');
select public.duo_add_saving_without_cash('prior-ars', 200000, date '2026-11-15', false, 'Ya ahorrado');
select public.duo_add_movement('prior-usd', 'saving', 200, date '2026-11-15', false, 'USD', null, '', 'deposit');
select public.duo_add_movement('monthly-ars', 'saving', 500, date '2026-11-15', false, 'ARS', null, '', 'deposit');
select public.duo_add_saving_without_cash('monthly-ars', 500, date '2026-11-15', false, '');
select public.duo_add_movement('withdraw', 'saving', 120000, date '2026-11-15', false, 'ARS', null, '', 'withdraw');

do $$
begin
  assert (select count(*) from public.duo_movements where exclude_from_monthly_cash) = 1;
  assert (select amount from public.duo_movements where exclude_from_monthly_cash) = 200000;
  assert (select sum(amount) from public.duo_movements where currency = 'ARS' and saving_kind = 'deposit') = 200500;
  assert exists (select 1 from public.duo_movements where currency = 'ARS' and saving_kind = 'withdraw');
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
insert into public.duo_profiles values (auth.uid(), 'Mel');
do $$
begin
  assert not exists (select 1 from public.duo_movements);
end;
$$;

rollback;

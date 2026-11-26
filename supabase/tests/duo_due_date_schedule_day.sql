begin;
set local plpgsql.check_asserts = on;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'duo-schedule@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
insert into public.duo_profiles values (auth.uid(), 'Marce');

select public.duo_save_due_date(null, 'resumen', 'Resumen', date '2027-01-31', 60000, 'ARS', 'bbva');
select public.duo_copy_due_dates(date '2027-02-01',
  array(select id from public.duo_due_dates where due_on = date '2027-01-31'), 'feb');
select public.duo_copy_due_dates(date '2027-03-01',
  array(select id from public.duo_due_dates where due_on = date '2027-02-28'), 'mar');

do $$
begin
  assert exists (select 1 from public.duo_due_dates where due_on = date '2027-02-28' and scheduled_day = 31);
  assert exists (select 1 from public.duo_due_dates where due_on = date '2027-03-31' and scheduled_day = 31
    and paid_on is null and category = 'bbva');
end;
$$;

select public.duo_save_due_date((select id from public.duo_due_dates where due_on = date '2027-03-31'),
  'reprogramar', 'Resumen', date '2027-03-18', 60000, 'ARS', 'bbva');
select public.duo_copy_due_dates(date '2027-04-01',
  array(select id from public.duo_due_dates where due_on = date '2027-03-18'), 'abr');
do $$
begin
  assert exists (select 1 from public.duo_due_dates where due_on = date '2027-04-18' and scheduled_day = 18);
end;
$$;

rollback;

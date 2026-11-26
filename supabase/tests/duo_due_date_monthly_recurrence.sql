begin;
set local plpgsql.check_asserts = on;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'duo-repeat-marce@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'duo-repeat-mel@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
insert into public.duo_profiles values (auth.uid(), 'Marce');
select set_config('duo.repeat_invite', public.duo_create_invite()::text, true);

select public.duo_save_due_date(null, 'service', 'Edesur', date '2027-01-31', 6000, 'ARS', 'luz');
select set_config('duo.repeat_source', (select id::text from public.duo_due_dates where title = 'Edesur'), true);
select public.duo_write_due_date('paid', current_setting('duo.repeat_source')::uuid,
  null, null, null, null, null, date '2027-01-29');
select public.duo_repeat_due_dates(date '2027-02-01', array[current_setting('duo.repeat_source')::uuid], 'repeat');
select public.duo_repeat_due_dates(date '2027-02-01', array[current_setting('duo.repeat_source')::uuid], 'retry');

select set_config('duo.repeat_feb', (select id::text from public.duo_due_dates where due_on = date '2027-02-28'), true);
select public.duo_save_due_date(current_setting('duo.repeat_feb')::uuid, 'edit-feb',
  'Edesur', date '2027-02-28', 7500, 'ARS', 'luz');
select public.duo_copy_due_dates(date '2027-03-01', array[current_setting('duo.repeat_feb')::uuid], 'manual');
select public.duo_generate_due_dates(date '2027-04-01');
select public.duo_generate_due_dates(date '2027-04-01');
do $$
begin
  assert (select count(*) = 1 from public.duo_due_date_schedules where active);
  assert (select count(*) = 4 from public.duo_due_dates);
  assert exists (select 1 from public.duo_due_dates where due_on = date '2027-02-28'
    and paid_on is null and scheduled_day = 31 and amount = 7500);
  assert exists (select 1 from public.duo_due_dates where due_on = date '2027-03-31' and amount = 6000);
  assert exists (select 1 from public.duo_due_dates where due_on = date '2027-04-30' and category = 'luz');
  assert not exists (select 1 from public.duo_movements);
end;
$$;

select public.duo_write_due_date('delete', (select id from public.duo_due_dates where due_on = date '2027-03-31'),
  null, null, null, null, null, null);
select public.duo_generate_due_dates(date '2027-04-01');
do $$ begin
  assert not exists (select 1 from public.duo_due_dates where due_on = date '2027-03-31');
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
insert into public.duo_profiles values (auth.uid(), 'Mel');
select public.duo_accept_invite(current_setting('duo.repeat_invite')::uuid);
select public.duo_generate_due_dates(date '2027-05-01');
do $$
begin
  assert not exists (select 1 from public.duo_due_date_schedules);
  assert not exists (select 1 from public.duo_due_dates);
  begin
    perform public.duo_stop_due_date_recurrence(current_setting('duo.repeat_feb')::uuid);
    raise exception 'Partner could disable a private recurrence';
  exception when raise_exception then
    if sqlerrm <> 'duo_due_date_unavailable' then raise; end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.duo_stop_due_date_recurrence((select id from public.duo_due_dates where due_on = date '2027-04-30'));
select public.duo_generate_due_dates(date '2027-05-01');
do $$
begin
  assert not exists (select 1 from public.duo_due_date_schedules where active);
  assert not exists (select 1 from public.duo_due_dates where due_on >= date '2027-05-01');
  assert (select count(*) = 3 from public.duo_due_dates);
end;
$$;

rollback;

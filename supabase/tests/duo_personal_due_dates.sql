begin;
set local plpgsql.check_asserts = on;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'duo-due-marce@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'duo-due-mel@example.invalid');
set local role authenticated;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
insert into public.duo_profiles values (auth.uid(), 'Marce');
select set_config('duo.invite', public.duo_create_invite()::text, true);
select public.duo_write_due_date('save', null, 'tarjeta', 'Tarjeta', date '2027-01-31', null, 'ARS', null);
select public.duo_write_due_date('save', null, 'tarjeta', 'Tarjeta', date '2027-01-31', null, 'ARS', null);
select set_config('duo.marce_due', (select id::text from public.duo_due_dates where title = 'Tarjeta'), true);
select public.duo_write_due_date('paid', current_setting('duo.marce_due')::uuid, null, null, null, null, null, date '2027-01-25');
do $$
begin
  assert (select count(*) = 1 from public.duo_due_dates);
  assert exists (select 1 from public.duo_due_dates where amount is null and paid_on = date '2027-01-25');
  assert not exists (select 1 from public.duo_movements);
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
insert into public.duo_profiles values (auth.uid(), 'Mel');
select public.duo_accept_invite(current_setting('duo.invite')::uuid);
select public.duo_write_due_date('save', null, 'Luz', 'Luz', date '2027-01-12', 8500, 'ARS', null);
select set_config('duo.mel_due', (select id::text from public.duo_due_dates where title = 'Luz'), true);
select public.duo_copy_due_dates(date '2027-02-01', array[current_setting('duo.marce_due')::uuid], 'foreign-copy');
do $$
begin
  assert (select count(*) = 1 from public.duo_due_dates);
  assert not exists (select 1 from public.duo_due_dates where title = 'Tarjeta');
  begin
    perform public.duo_write_due_date('paid', current_setting('duo.marce_due')::uuid, null, null, null, null, null, null);
    raise exception 'a linked partner could mark someone else''s due date';
  exception when raise_exception then
    if sqlerrm <> 'duo_due_date_unavailable' then raise; end if;
  end;
  assert not has_table_privilege('public.duo_due_dates', 'update');
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.duo_copy_due_dates(date '2027-02-01', array[current_setting('duo.marce_due')::uuid, current_setting('duo.mel_due')::uuid], 'copy');
select public.duo_copy_due_dates(date '2027-02-01', array[current_setting('duo.marce_due')::uuid], 'copy-again');
select set_config('duo.copy', (select id::text from public.duo_due_dates where copied_month = date '2027-02-01'), true);
do $$
begin
  assert (select count(*) = 2 from public.duo_due_dates);
  assert exists (select 1 from public.duo_due_dates where due_on = date '2027-02-28' and paid_on is null);
  assert not exists (select 1 from public.duo_due_dates where title = 'Luz');
end;
$$;
select public.duo_write_due_date('save', current_setting('duo.copy')::uuid, null, 'Resumen', date '2027-02-25', 50, 'USD', null);
do $$
begin
  assert exists (select 1 from public.duo_due_dates where title = 'Resumen' and amount = 50 and currency = 'USD');
end;
$$;
select public.duo_write_due_date('delete', current_setting('duo.copy')::uuid, null, null, null, null, null, null);
select public.duo_copy_due_dates(date '2027-02-01', array[current_setting('duo.marce_due')::uuid], 'copy');
do $$
begin
  assert (select count(*) = 1 from public.duo_due_dates);
  assert not exists (select 1 from public.duo_movements);
end;
$$;

rollback;

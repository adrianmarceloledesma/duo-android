begin;
set local plpgsql.check_asserts = on;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'duo-payment-marce@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'duo-payment-mel@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
insert into public.duo_profiles values (auth.uid(), 'Marce');
select set_config('duo.invite', public.duo_create_invite()::text, true);
select public.duo_save_due_date(null, 'card', 'Resumen BBVA', date '2026-11-18', 60000, 'ARS', 'bbva');
select public.duo_save_due_date(null, 'card', 'Resumen BBVA', date '2026-11-18', 60000, 'ARS', 'bbva');
select set_config('duo.card', (select id::text from public.duo_due_dates where title = 'Resumen BBVA'), true);

do $$
begin
  begin
    perform public.duo_pay_due_date(current_setting('duo.card')::uuid, 'split', date '2026-11-17', 60000, 20000);
    raise exception 'unlinked shared payment accepted';
  exception when raise_exception then
    if sqlerrm <> 'duo_link_required' then raise; end if;
  end;
  assert (select count(*) = 1 from public.duo_due_dates);
  assert (select paid_on is null from public.duo_due_dates where id = current_setting('duo.card')::uuid);
  assert not exists (select 1 from public.duo_movements);
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
insert into public.duo_profiles values (auth.uid(), 'Mel');
select public.duo_accept_invite(current_setting('duo.invite')::uuid);
do $$
begin
  begin
    perform public.duo_pay_due_date(current_setting('duo.card')::uuid, 'foreign', date '2026-11-17', 60000, 20000);
    raise exception 'foreign due date payment accepted';
  exception when raise_exception then
    if sqlerrm <> 'duo_due_date_unavailable' then raise; end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.duo_pay_due_date(current_setting('duo.card')::uuid, 'split', date '2026-11-17', 60000, 20000);
select public.duo_pay_due_date(current_setting('duo.card')::uuid, 'split', date '2026-11-17', 60000, 20000);
select public.duo_copy_due_dates(date '2026-12-01', array[current_setting('duo.card')::uuid], 'copy');
do $$
begin
  assert (select count(*) = 2 from public.duo_movements);
  assert (select sum(amount) = 60000 from public.duo_movements);
  assert exists (select 1 from public.duo_movements where amount = 40000 and pair_id is null and category = 'bbva');
  assert exists (select 1 from public.duo_movements where amount = 20000 and pair_id is not null and category = 'bbva');
  assert exists (select 1 from public.duo_due_dates where due_on = date '2026-11-18'
    and paid_on = date '2026-11-17' and cardinality(payment_expense_ids) = 2);
  assert exists (select 1 from public.duo_due_dates where due_on = date '2026-12-18'
    and paid_on is null and category = 'bbva' and cardinality(payment_expense_ids) = 0);
end;
$$;

select public.duo_write_due_date('paid', current_setting('duo.card')::uuid, null, null, null, null, null, null);
do $$
begin
  begin
    perform public.duo_pay_due_date(current_setting('duo.card')::uuid, 'second', date '2026-11-19', 60000, 20000);
    raise exception 'linked payment could be duplicated';
  exception when raise_exception then
    if sqlerrm <> 'duo_due_date_expense_exists' then raise; end if;
  end;
end;
$$;
select public.duo_pay_due_date(current_setting('duo.card')::uuid, 'check', date '2026-11-17', null, null);

select public.duo_write_due_date('save', null, 'legacy', 'Otro pago', date '2026-11-20', 40, 'USD', null);
select public.duo_pay_due_date((select id from public.duo_due_dates where title = 'Otro pago'), 'personal-usd',
  date '2026-11-19', 40, 0);
do $$
begin
  assert exists (select 1 from public.duo_movements where amount = 40 and currency = 'USD'
    and pair_id is null and category = 'otros');
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
do $$
begin
  assert not exists (select 1 from public.duo_due_dates);
  assert (select count(*) = 1 and sum(amount) = 20000 from public.duo_movements);
end;
$$;

rollback;

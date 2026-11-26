begin;
set local plpgsql.check_asserts = on;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'duo-edit-marce@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'duo-edit-mel@example.invalid');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
insert into public.duo_profiles values (auth.uid(), 'Marce');
select public.duo_add_movement('expense', 'expense', 101, date '2026-11-14', false, 'ARS', 'nafta', 'Personal', null);
select set_config('duo.expense_id', (select id::text from public.duo_movements), true);
select set_config('duo.test_invite', public.duo_create_invite()::text, true);

do $$
begin
  begin
    perform public.duo_change_expense(current_setting('duo.expense_id')::uuid, false, 120, 'luz', '', date '2026-11-15', true);
    raise exception 'unlinked owner could share an expense';
  exception when raise_exception then
    if sqlerrm <> 'duo_link_required' then raise; end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
insert into public.duo_profiles values (auth.uid(), 'Mel');
select public.duo_accept_invite(current_setting('duo.test_invite')::uuid);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.duo_change_expense(current_setting('duo.expense_id')::uuid, false, 201, 'luz', 'Editar y compartir', date '2026-11-15', true);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
do $$
begin
  assert (select count(*) from public.duo_movements) = 1;
  assert exists (select 1 from public.duo_movements where id = current_setting('duo.expense_id')::uuid
    and amount = 201 and movement_date = date '2026-11-15' and category = 'luz' and note = 'Editar y compartir');
  begin
    perform public.duo_change_expense(current_setting('duo.expense_id')::uuid, false, 15, 'nafta', '', date '2026-11-15', false);
    raise exception 'partner could edit a shared expense';
  exception when raise_exception then
    if sqlerrm <> 'duo_expense_unavailable' then raise; end if;
  end;
  begin
    perform public.duo_change_expense(current_setting('duo.expense_id')::uuid, true, null, null, null, null, null);
    raise exception 'partner could delete a shared expense';
  exception when raise_exception then
    if sqlerrm <> 'duo_expense_unavailable' then raise; end if;
  end;
end;
$$;
select public.duo_add_movement('payment', 'transfer', 50.50, date '2026-11-15', false, 'ARS', null, '', null);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.duo_change_expense(current_setting('duo.expense_id')::uuid, false, 201, 'luz', 'Personal otra vez', date '2026-11-15', false);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
do $$
begin
  assert not exists (select 1 from public.duo_movements where kind = 'expense');
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.duo_change_expense(current_setting('duo.expense_id')::uuid, false, 201, 'luz', 'Compartido otra vez', date '2026-11-15', true);
select public.duo_change_expense(current_setting('duo.expense_id')::uuid, true, null, null, null, null, null);
select public.duo_change_expense(current_setting('duo.expense_id')::uuid, true, null, null, null, null, null);
select public.duo_add_movement('expense', 'expense', 101, date '2026-11-14', false, 'ARS', 'nafta', 'Intento repetido', null);
do $$
begin
  assert not exists (select 1 from public.duo_movements where kind = 'expense');
  assert exists (select 1 from public.duo_movements where kind = 'transfer' and amount = 50.50);
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
do $$
begin
  assert not exists (select 1 from public.duo_movements where kind = 'expense');
  begin
    perform public.duo_add_movement('payment-after-delete', 'transfer', 1, date '2026-11-15', false, 'ARS', null, '', null);
    raise exception 'deleted expense still counts toward debt';
  exception when raise_exception then
    if sqlerrm <> 'duo_transfer_exceeds_debt' then raise; end if;
  end;
end;
$$;

rollback;

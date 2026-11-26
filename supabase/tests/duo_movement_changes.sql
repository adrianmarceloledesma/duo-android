begin;
set local plpgsql.check_asserts = on;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'duo-moves-marce@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'duo-moves-mel@example.invalid');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
insert into public.duo_profiles values (auth.uid(), 'Marce');
select set_config('duo.invite', public.duo_create_invite()::text, true);
select public.duo_add_movement('income', 'income', 3000, date '2026-11-14', false, 'ARS', null, 'Sueldo', null);
select public.duo_add_saving_without_cash('saving', 900, date '2026-11-15', false, 'Ahorro previo');
select public.duo_add_movement('withdraw', 'saving', 400, date '2026-11-15', false, 'ARS', null, '', 'withdraw');
select set_config('duo.income', (select id::text from public.duo_movements where request_key = 'income'), true);
select set_config('duo.saving', (select id::text from public.duo_movements where request_key = 'saving'), true);
select set_config('duo.withdraw', (select id::text from public.duo_movements where request_key = 'withdraw'), true);

select public.duo_change_movement(current_setting('duo.income')::uuid, 'income', false, 2500, date '2026-11-15', 'Ingreso corregido', null, false);
select public.duo_change_movement(current_setting('duo.saving')::uuid, 'saving', false, 700, date '2026-11-15', 'Aporte corregido', 'deposit', true);
do $$
begin
  assert exists (select 1 from public.duo_movements where request_key = 'income' and amount = 2500 and note = 'Ingreso corregido');
  assert exists (select 1 from public.duo_movements where request_key = 'saving' and amount = 700 and exclude_from_monthly_cash);
  begin
    perform public.duo_change_movement(current_setting('duo.saving')::uuid, 'saving', true, null, null, null, null, false);
    raise exception 'allowed a negative savings balance';
  exception when raise_exception then
    if sqlerrm <> 'duo_saving_balance_negative' then raise; end if;
  end;
end;
$$;
select public.duo_change_movement(current_setting('duo.withdraw')::uuid, 'saving', true, null, null, null, null, false);
select public.duo_change_movement(current_setting('duo.saving')::uuid, 'saving', true, null, null, null, null, false);
select public.duo_change_movement(current_setting('duo.income')::uuid, 'income', true, null, null, null, null, false);
select public.duo_add_movement('income', 'income', 3000, date '2026-11-14', false, 'ARS', null, 'Sueldo', null);
do $$
begin
  assert not exists (select 1 from public.duo_movements);
  begin
    perform public.duo_add_movement('withdraw-again', 'saving', 1, date '2026-11-15', false, 'ARS', null, '', 'withdraw');
    raise exception 'deleted deposit funds a new withdrawal';
  exception when raise_exception then
    if sqlerrm <> 'duo_insufficient_savings' then raise; end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
insert into public.duo_profiles values (auth.uid(), 'Mel');
select public.duo_accept_invite(current_setting('duo.invite')::uuid);
select public.duo_add_movement('shared-expense', 'expense', 100, date '2026-11-14', true, 'ARS', 'luz', '', null);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.duo_add_movement('payment', 'transfer', 50, date '2026-11-15', false, 'ARS', null, '', null);
select set_config('duo.payment', (select id::text from public.duo_movements where request_key = 'payment'), true);
select public.duo_change_movement(current_setting('duo.payment')::uuid, 'transfer', false, 50, date '2026-11-14', 'Corrección', null, false);
do $$
begin
  assert exists (select 1 from public.duo_movements where request_key = 'payment'
    and recipient_id = '00000000-0000-4000-8000-000000000002' and note = 'Corrección');
  begin
    perform public.duo_change_movement(current_setting('duo.payment')::uuid, 'transfer', false, 51, date '2026-11-15', '', null, false);
    raise exception 'allowed a transfer greater than debt';
  exception when raise_exception then
    if sqlerrm <> 'duo_transfer_exceeds_debt' then raise; end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
do $$
begin
  begin
    perform public.duo_change_movement(current_setting('duo.payment')::uuid, 'transfer', true, null, null, null, null, false);
    raise exception 'partner could delete a received transfer';
  exception when raise_exception then
    if sqlerrm <> 'duo_movement_unavailable' then raise; end if;
  end;
end;
$$;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.duo_change_movement(current_setting('duo.payment')::uuid, 'transfer', true, null, null, null, null, false);
select public.duo_add_movement('replacement', 'transfer', 50, date '2026-11-15', false, 'ARS', null, '', null);

rollback;

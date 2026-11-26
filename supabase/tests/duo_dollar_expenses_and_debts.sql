begin;
set local plpgsql.check_asserts = on;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'duo-usd-marce@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'duo-usd-mel@example.invalid'),
  ('00000000-0000-4000-8000-000000000003', 'duo-usd-other@example.invalid');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
insert into public.duo_profiles values (auth.uid(), 'Marce');
select set_config('duo.invite', public.duo_create_invite()::text, true);
do $$
begin
  begin
    perform public.duo_add_movement('unlinked', 'debt', 2000, date '2026-11-16', false, 'USD', null, 'Auto', null);
    raise exception 'an unlinked account could register a debt';
  exception when raise_exception then
    if sqlerrm <> 'duo_link_required' then raise; end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
insert into public.duo_profiles values (auth.uid(), 'Mel');
select public.duo_accept_invite(current_setting('duo.invite')::uuid);
select public.duo_add_movement('usd-private', 'expense-usd', 23, date '2026-11-16', false, 'USD', 'compras', '', null);
select public.duo_add_movement('usd-shared', 'expense-usd', 501, date '2026-11-16', true, 'USD', 'compras', '', null);
select public.duo_add_movement('ars-shared', 'expense', 100, date '2026-11-16', true, 'ARS', 'compras', '', null);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.duo_add_movement('auto', 'debt', 2000, date '2026-11-16', false, 'USD', null, 'Compra del auto', null);
select public.duo_add_movement('auto', 'debt', 2000, date '2026-11-16', false, 'USD', null, 'Compra del auto', null);
select public.duo_add_movement('ars-payment', 'transfer', 50, date '2026-11-16', false, 'ARS', null, '', null);
select public.duo_add_movement('usd-payment', 'transfer-usd', 500, date '2026-11-16', false, 'USD', null, '', null);
select set_config('duo.auto', (select id::text from public.duo_movements where request_key = 'auto'), true);
select set_config('duo.usd_payment', (select id::text from public.duo_movements where request_key = 'usd-payment'), true);
do $$
begin
  assert not exists (select 1 from public.duo_movements where request_key = 'usd-private');
  assert (select count(*) = 1 from public.duo_movements where request_key = 'auto');
  begin
    perform public.duo_add_movement('ars-too-much', 'transfer', 1, date '2026-11-16', false, 'ARS', null, '', null);
    raise exception 'dollar debt increased peso debt';
  exception when raise_exception then
    if sqlerrm <> 'duo_transfer_exceeds_debt' then raise; end if;
  end;
  begin
    perform public.duo_change_movement(current_setting('duo.usd_payment')::uuid, 'transfer-usd', false,
      2251, date '2026-11-16', '', null, false);
    raise exception 'edited payment exceeded dollar debt';
  exception when raise_exception then
    if sqlerrm <> 'duo_transfer_exceeds_debt' then raise; end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
do $$
begin
  assert exists (select 1 from public.duo_movements where request_key = 'auto' and recipient_id = auth.uid());
  begin
    perform public.duo_add_movement('wrong-direction', 'transfer-usd', 1, date '2026-11-16', false, 'USD', null, '', null);
    raise exception 'creditor could record a dollar payment';
  exception when raise_exception then
    if sqlerrm <> 'duo_transfer_exceeds_debt' then raise; end if;
  end;
  begin
    perform public.duo_change_movement(current_setting('duo.auto')::uuid, 'debt', true, null, null, null, null, false);
    raise exception 'creditor could delete someone else''s debt';
  exception when raise_exception then
    if sqlerrm <> 'duo_movement_unavailable' then raise; end if;
  end;
end;
$$;

select public.duo_change_expense_currency(
  (select id from public.duo_movements where request_key = 'usd-shared'),
  false, 200, 'compras', 'Cambio de moneda', date '2026-11-16', true, 'ARS');
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.duo_add_movement('ars-after-change', 'transfer', 100, date '2026-11-16', false, 'ARS', null, '', null);
select public.duo_change_movement(current_setting('duo.auto')::uuid, 'debt', false,
  2001, date '2026-11-16', 'Compra del auto corregida', null, false);
select public.duo_add_movement('usd-rest', 'transfer-usd', 1501, date '2026-11-16', false, 'USD', null, '', null);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
select public.duo_save_debt_receivable('mel-auto', null, false, 2050, date '2026-11-16', 'Compra del auto');
select public.duo_save_debt_receivable('mel-auto', null, false, 2050, date '2026-11-16', 'Compra del auto');
select set_config('duo.receivable', (select id::text from public.duo_movements where request_key = 'mel-auto'), true);
select public.duo_save_debt_receivable(null, current_setting('duo.receivable')::uuid, false,
  2000, date '2026-11-16', 'Compra del auto');
do $$
begin
  assert (select count(*) = 1 from public.duo_movements where request_key = 'mel-auto' and owner_id = auth.uid());
  begin
    perform public.duo_add_movement('mel-cannot-pay', 'transfer-usd', 1, date '2026-11-16', false, 'USD', null, '', null);
    raise exception 'creditor could pay a debt she entered';
  exception when raise_exception then
    if sqlerrm <> 'duo_transfer_exceeds_debt' then raise; end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
do $$
begin
  assert exists (select 1 from public.duo_movements where request_key = 'mel-auto'
    and amount = 2000 and currency = 'USD' and recipient_id = auth.uid());
  begin
    perform public.duo_save_debt_receivable(null, current_setting('duo.receivable')::uuid, true, null, null, null);
    raise exception 'debtor could delete the creditor''s entry';
  exception when raise_exception then
    if sqlerrm <> 'duo_movement_unavailable' then raise; end if;
  end;
end;
$$;
select public.duo_add_movement('marce-partial', 'transfer-usd', 500, date '2026-11-16', false, 'USD', null, '', null);
do $$
begin
  begin
    perform public.duo_add_movement('too-much', 'transfer-usd', 1501, date '2026-11-16', false, 'USD', null, '', null);
    raise exception 'payment exceeded remaining receivable';
  exception when raise_exception then
    if sqlerrm <> 'duo_transfer_exceeds_debt' then raise; end if;
  end;
end;
$$;
select public.duo_add_movement('marce-final', 'transfer-usd', 1500, date '2026-11-16', false, 'USD', null, '', null);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', true);
insert into public.duo_profiles values (auth.uid(), 'Otra cuenta');
do $$
begin
  assert not exists (select 1 from public.duo_movements);
  assert not has_function_privilege('public.duo_debt_available(uuid,uuid,text,uuid)', 'execute');
end;
$$;

rollback;

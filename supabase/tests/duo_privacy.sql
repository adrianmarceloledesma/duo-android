-- Execute as postgres in a test database after applying the migration.
-- The transaction is rolled back even when the checks pass.
begin;
set local plpgsql.check_asserts = on;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'duo-test-marce@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'duo-test-mel@example.invalid'),
  ('00000000-0000-4000-8000-000000000003', 'duo-test-otro@example.invalid');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
insert into public.duo_profiles values (auth.uid(), 'Marce');
select public.duo_add_movement('private', 'expense', 90, date '2026-11-14', false, 'ARS', 'nafta', 'Personal de Marce', null);
select public.duo_add_movement('income', 'income', 200, date '2026-11-14', false, 'ARS', null, '', null);
select public.duo_add_movement('personal-saving', 'saving', 100, date '2026-11-14', false, 'USD', null, '', 'deposit');
select set_config('duo.test_invite', public.duo_create_invite()::text, true);

do $$
begin
  assert (select count(*) from public.duo_partner()) = 0;
  assert public.duo_create_invite()::text = current_setting('duo.test_invite');
  begin
    perform public.duo_accept_invite(current_setting('duo.test_invite')::uuid);
    raise exception 'accepted own invite';
  exception when raise_exception then
    if sqlerrm <> 'duo_own_invite' then raise; end if;
  end;
  begin
    perform public.duo_add_movement('too-early', 'expense', 5, date '2026-11-14', true, 'ARS', 'luz', '', null);
    raise exception 'unlinked user shared a movement';
  exception when raise_exception then
    if sqlerrm <> 'duo_link_required' then raise; end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
insert into public.duo_profiles values (auth.uid(), 'Mel');
select public.duo_add_movement('private', 'expense', 80, date '2026-11-14', false, 'ARS', 'salud', 'Personal de Mel', null);
select public.duo_create_invite();
select public.duo_accept_invite(current_setting('duo.test_invite')::uuid);

do $$
begin
  assert (select display_name from public.duo_partner()) = 'Marce';
  assert (select count(*) from public.duo_profiles) = 1;
  assert (select count(*) from public.duo_movements) = 1;
  assert (select note from public.duo_movements) = 'Personal de Mel';
  begin
    delete from public.duo_movements;
    raise exception 'authenticated user can delete movements';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select public.duo_add_movement('shared', 'expense', 101, date '2026-11-14', true, 'ARS', 'luz', 'Gasto compartido', null);
select public.duo_add_movement('shared', 'expense', 101, date '2026-11-14', true, 'ARS', 'luz', 'Gasto compartido', null);
select public.duo_add_movement('shared-saving', 'saving', 300, date '2026-11-14', true, 'USD', null, '', 'deposit');

do $$
begin
  begin
    perform public.duo_add_movement('reverse', 'transfer', 20, date '2026-11-14', false, 'ARS', null, '', null);
    raise exception 'creditor can register payment';
  exception when raise_exception then
    if sqlerrm <> 'duo_transfer_exceeds_debt' then raise; end if;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);

do $$
begin
  assert (select display_name from public.duo_partner()) = 'Mel';
  assert (select count(*) from public.duo_movements) = 5;
  assert (select count(*) from public.duo_movements where kind = 'expense' and pair_id is not null) = 1;
  assert not exists (select 1 from public.duo_movements where note = 'Personal de Mel');
  begin
    perform public.duo_add_movement('too-much', 'transfer', 51, date '2026-11-14', false, 'ARS', null, '', null);
    raise exception 'debtor can overpay';
  exception when raise_exception then
    if sqlerrm <> 'duo_transfer_exceeds_debt' then raise; end if;
  end;
  begin
    perform public.duo_add_movement('wrong-currency', 'saving', 1, date '2026-11-14', true, 'ARS', null, '', 'withdraw');
    raise exception 'can withdraw from the wrong currency';
  exception when raise_exception then
    if sqlerrm <> 'duo_insufficient_savings' then raise; end if;
  end;
end;
$$;

select public.duo_add_movement('partial', 'transfer', 30, date '2026-11-14', false, 'ARS', null, '', null);
select public.duo_add_movement('final', 'transfer', 20.50, date '2026-11-14', false, 'ARS', null, '', null);
select public.duo_add_movement('final', 'transfer', 20.50, date '2026-11-14', false, 'ARS', null, '', null);
select public.duo_add_movement('withdraw-usd', 'saving', 20, date '2026-11-14', true, 'USD', null, '', 'withdraw');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
do $$
begin
  assert (select count(*) from public.duo_movements) = 6;
  assert (select sum(amount) from public.duo_movements where kind = 'transfer' and recipient_id = auth.uid()) = 50.50;
  assert not exists (select 1 from public.duo_movements where pair_id is null and owner_id <> auth.uid());
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', true);
insert into public.duo_profiles values (auth.uid(), 'Otra persona');
do $$
begin
  assert (select count(*) from public.duo_movements) = 0;
  assert (select count(*) from public.duo_partner()) = 0;
  begin
    perform public.duo_accept_invite(current_setting('duo.test_invite')::uuid);
    raise exception 'reused invite';
  exception when raise_exception then
    if sqlerrm <> 'duo_invalid_invite' then raise; end if;
  end;
end;
$$;

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  begin
    perform 1 from public.duo_movements;
    raise exception 'anonymous user can read movements';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.duo_create_invite();
    raise exception 'anonymous user can create invites';
  exception when insufficient_privilege then null;
  end;
end;
$$;

rollback;

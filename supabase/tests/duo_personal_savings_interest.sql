begin;
set local plpgsql.check_asserts = on;
insert into auth.users(id,email) values
  ('40000000-0000-4000-8000-000000000001','interest-a@example.invalid'),
  ('40000000-0000-4000-8000-000000000002','interest-b@example.invalid'),
  ('40000000-0000-4000-8000-000000000003','interest-c@example.invalid');
insert into public.duo_profiles values
  ('40000000-0000-4000-8000-000000000001','Marce'),
  ('40000000-0000-4000-8000-000000000002','Mel'),
  ('40000000-0000-4000-8000-000000000003','Outsider');
set local role authenticated;
select set_config('request.jwt.claim.sub','40000000-0000-4000-8000-000000000001',true);
select set_config('test.interest_invite',public.duo_create_invite()::text,true);
select set_config('request.jwt.claim.sub','40000000-0000-4000-8000-000000000002',true);
select public.duo_accept_invite(current_setting('test.interest_invite')::uuid);
select public.duo_add_saving_without_cash('b-personal',60000,'2026-11-19',false,'Other personal');
select set_config('request.jwt.claim.sub','40000000-0000-4000-8000-000000000001',true);
select public.duo_add_saving_without_cash('a-personal',200000,'2026-11-19',false,'Personal');
select public.duo_add_saving_without_cash('a-shared',100000,'2026-11-19',true,'Shared');
select public.duo_add_movement('a-usd','saving',200,'2026-11-19',false,'USD',null,'Dollars','deposit');
select public.duo_set_personal_interest(18.9);
do $$ begin
  assert (public.duo_personal_interest_status()->>'annual_percent')::numeric = 18.9;
  assert (select count(*) from public.duo_personal_savings_interest) = 1;
  assert not exists(select 1 from public.duo_movements where savings_interest_on is not null), 'Activation credited unclosed days';
  assert not has_function_privilege('public.duo_settle_personal_interest(uuid,date)','execute');
  assert not has_function_privilege('public.duo_settle_all_personal_interest()','execute');
  assert not has_table_privilege('public.duo_personal_savings_interest','update');
  begin
    perform public.duo_set_personal_interest(-1);
    raise exception 'Negative rate accepted';
  exception when raise_exception then if sqlerrm <> 'duo_invalid_interest_rate' then raise; end if; end;
end $$;
select set_config('request.jwt.claim.sub','40000000-0000-4000-8000-000000000002',true);
do $$ begin assert (select count(*) from public.duo_personal_savings_interest) = 0, 'Personal rate leaked to partner'; end $$;
reset role;
-- Isolated simulation: a rate enabled on November 19. Only the private test clock advances.
update public.duo_personal_savings_interest set starts_on='2026-11-19',settled_through='2026-11-18'
where owner_id='40000000-0000-4000-8000-000000000001';
select public.duo_settle_personal_interest('40000000-0000-4000-8000-000000000001','2026-11-20');
select public.duo_settle_personal_interest('40000000-0000-4000-8000-000000000001','2026-11-20');
select public.duo_settle_personal_interest('40000000-0000-4000-8000-000000000001','2026-11-21');
do $$ begin
  assert (select count(*) from public.duo_movements where savings_interest_on is not null) = 2;
  assert (select amount from public.duo_movements where savings_interest_on='2026-11-19') = 103.56;
  assert (select amount from public.duo_movements where savings_interest_on='2026-11-20') = 103.62;
  assert (select sum(amount) from public.duo_movements where kind='saving' and currency='ARS' and pair_id is null and owner_id='40000000-0000-4000-8000-000000000001') = 200207.18;
  assert not exists(select 1 from public.duo_movements where savings_interest_on is not null and
    (pair_id is not null or currency <> 'ARS' or owner_id <> '40000000-0000-4000-8000-000000000001' or not exclude_from_monthly_cash));
  assert (select sum(amount) from public.duo_movements where pair_id is not null) = 100000;
  assert (select sum(amount) from public.duo_movements where currency='USD') = 200;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','40000000-0000-4000-8000-000000000002',true);
do $$ begin
  assert not exists(select 1 from public.duo_movements where savings_interest_on is not null), 'Interest leaked to partner';
end $$;
select set_config('request.jwt.claim.sub','40000000-0000-4000-8000-000000000001',true);
select public.duo_change_movement((select id from public.duo_movements where savings_interest_on='2026-11-19'), 'saving', false, 150,'2026-11-19','Corrección','deposit',true);
select public.duo_change_movement((select id from public.duo_movements where savings_interest_on='2026-11-20'), 'saving', true, null,null,null,null,false);
reset role;
select public.duo_settle_personal_interest('40000000-0000-4000-8000-000000000001','2026-11-22');
do $$ begin
  assert (select amount from public.duo_movements where savings_interest_on='2026-11-21') = 103.64;
  assert (select deleted_at is not null from public.duo_movements where savings_interest_on='2026-11-20');
end $$;
-- Rewinding progress simulates a duplicate attempt; even a deleted credit is not recreated.
update public.duo_personal_savings_interest set settled_through='2026-11-18';
select public.duo_settle_personal_interest('40000000-0000-4000-8000-000000000001','2026-11-22');
do $$ begin assert (select count(*) from public.duo_movements where savings_interest_on is not null) = 3; end $$;

-- Changing the rate settles pending past days with the previous rate before taking effect today.
select set_config('test.real_today',((clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date)::text,true);
insert into public.duo_personal_savings_interest(owner_id,annual_percent,starts_on,settled_through)
values('40000000-0000-4000-8000-000000000003',36.5,current_setting('test.real_today')::date-2,current_setting('test.real_today')::date-3);
set local role authenticated;
select set_config('request.jwt.claim.sub','40000000-0000-4000-8000-000000000003',true);
select public.duo_add_saving_without_cash('c-personal',100000,current_setting('test.real_today')::date-2,false,'Personal');
select public.duo_set_personal_interest(73);
do $$ begin
  assert (select sum(amount) from public.duo_movements where savings_interest_on is not null) = 200.10;
  assert (select bool_and(savings_interest_tna=36.5) from public.duo_movements where savings_interest_on is not null);
  assert (select annual_percent from public.duo_personal_savings_interest)=73;
end $$;
select public.duo_set_personal_interest(0);
reset role;
select public.duo_settle_personal_interest('40000000-0000-4000-8000-000000000003',current_setting('test.real_today')::date+4);
do $$ begin assert (select count(*) from public.duo_movements where owner_id='40000000-0000-4000-8000-000000000003' and savings_interest_on is not null)=2; end $$;
rollback;

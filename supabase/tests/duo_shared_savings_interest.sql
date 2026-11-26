begin;
set local plpgsql.check_asserts = on;
insert into auth.users(id,email) values
  ('50000000-0000-4000-8000-000000000001','shared-interest-a@example.invalid'),
  ('50000000-0000-4000-8000-000000000002','shared-interest-b@example.invalid'),
  ('50000000-0000-4000-8000-000000000003','shared-interest-outsider@example.invalid');
insert into public.duo_profiles values
  ('50000000-0000-4000-8000-000000000001','Marce'),
  ('50000000-0000-4000-8000-000000000002','Mel'),
  ('50000000-0000-4000-8000-000000000003','Outsider');
set local role authenticated;
select set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000001',true);
select set_config('test.shared_invite',public.duo_create_invite()::text,true);
select set_config('test.shared_pair',public.duo_current_pair()::text,true);
select set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000002',true);
select public.duo_accept_invite(current_setting('test.shared_invite')::uuid);
select public.duo_add_saving_without_cash('shared-b',100000,'2026-11-19',true,'Mel');
select public.duo_set_shared_interest(18.9);
select set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000001',true);
select public.duo_add_saving_without_cash('shared-a',100000,'2026-11-19',true,'Marce');
select public.duo_add_saving_without_cash('personal-a',200000,'2026-11-19',false,'Personal');
select public.duo_add_movement('shared-usd','saving',200,'2026-11-19',true,'USD',null,'Dollars','deposit');
select public.duo_set_personal_interest(18.9);
do $$ begin
  assert (public.duo_shared_interest_status()->>'annual_percent')::numeric=18.9, 'Partner did not see the shared rate';
  assert (select count(*) from public.duo_shared_savings_interest)=1;
  assert not exists(select 1 from public.duo_movements where savings_interest_on is not null), 'Retroactive credit on activation';
  assert not has_function_privilege('public.duo_settle_shared_interest(uuid,date)','execute');
  assert not has_function_privilege('public.duo_settle_all_shared_interest()','execute');
  assert not has_table_privilege('public.duo_shared_savings_interest','update');
  begin
    perform public.duo_set_shared_interest(18.12345);
    raise exception 'Invalid precision accepted';
  exception when raise_exception then if sqlerrm <> 'duo_invalid_interest_rate' then raise; end if; end;
end $$;
reset role;
update public.duo_shared_savings_interest set starts_on='2026-11-19',settled_through='2026-11-18';
update public.duo_personal_savings_interest set starts_on='2026-11-19',settled_through='2026-11-18';
select public.duo_settle_personal_interest('50000000-0000-4000-8000-000000000001','2026-11-21');
select public.duo_settle_shared_interest(current_setting('test.shared_pair')::uuid,'2026-11-20');
select public.duo_settle_shared_interest(current_setting('test.shared_pair')::uuid,'2026-11-21');
select public.duo_settle_shared_interest(current_setting('test.shared_pair')::uuid,'2026-11-21');
do $$ begin
  assert (select count(*) from public.duo_movements where savings_interest_on is not null)=4, 'Personal/shared day collision or duplicated shared credit';
  assert (select amount from public.duo_movements where pair_id is not null and savings_interest_on='2026-11-19')=103.56;
  assert (select amount from public.duo_movements where pair_id is not null and savings_interest_on='2026-11-20')=103.62;
  assert (select sum(amount) from public.duo_movements where pair_id is not null and currency='ARS')=200207.18;
  assert (select sum(amount) from public.duo_movements where pair_id is null and currency='ARS')=200207.18;
  assert (select sum(amount) from public.duo_movements where currency='USD')=200;
  assert not exists(select 1 from public.duo_movements where savings_interest_on is not null and not exclude_from_monthly_cash);
  assert not exists(select 1 from public.duo_movements where kind in ('expense','transfer','debt-receivable'));
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000002',true);
do $$ begin
  assert (select count(*) from public.duo_movements where savings_interest_on is not null)=2, 'Private interest leaked or shared interest hidden';
  assert (select annual_percent from public.duo_shared_savings_interest)=18.9;
end $$;
-- A withdrawal from either member changes the following shared-day calculation.
select public.duo_add_movement('shared-withdraw','saving',100000,'2026-11-21',true,'ARS',null,'Withdraw','withdraw');
reset role;
select public.duo_settle_shared_interest(current_setting('test.shared_pair')::uuid,'2026-11-22');
do $$ begin
  assert (select amount from public.duo_movements where pair_id is not null and savings_interest_on='2026-11-21')=51.89;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000001',true);
select public.duo_change_movement((select id from public.duo_movements where pair_id is not null and savings_interest_on='2026-11-19'), 'saving', true, null,null,null,null,false);
reset role;
update public.duo_shared_savings_interest set settled_through='2026-11-18';
select public.duo_settle_shared_interest(current_setting('test.shared_pair')::uuid,'2026-11-22');
do $$ begin
  assert (select count(*) from public.duo_movements where pair_id is not null and savings_interest_on is not null)=3, 'Deleted interest recreated';
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000002',true);
select public.duo_set_shared_interest(0);
reset role;
-- Pausing settles all closed days first; the number varies with today's date.
select set_config('test.shared_credit_count', (select count(*)::text from public.duo_movements where pair_id is not null and savings_interest_on is not null), true);
select public.duo_settle_shared_interest(current_setting('test.shared_pair')::uuid,'2099-01-01');
do $$ begin assert (select count(*) from public.duo_movements where pair_id is not null and savings_interest_on is not null)=current_setting('test.shared_credit_count')::integer, 'Paused rate credited future interest'; end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000003',true);
do $$ begin
  assert (select count(*) from public.duo_shared_savings_interest)=0, 'Unrelated account saw the shared rate';
  assert (select count(*) from public.duo_movements)=0, 'Unrelated account saw movements';
  assert public.duo_shared_interest_status() is null;
  begin
    perform public.duo_set_shared_interest(20);
    raise exception 'Unlinked user configured shared interest';
  exception when raise_exception then if sqlerrm <> 'duo_link_required' then raise; end if; end;
end $$;
rollback;

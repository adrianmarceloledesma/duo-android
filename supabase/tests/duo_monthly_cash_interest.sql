begin;
set local plpgsql.check_asserts=on;
insert into auth.users(id,email) values
 ('60000000-0000-4000-8000-000000000001','cash-a@example.invalid'),
 ('60000000-0000-4000-8000-000000000002','cash-b@example.invalid'),
 ('60000000-0000-4000-8000-000000000003','cash-c@example.invalid');
insert into public.duo_profiles values
 ('60000000-0000-4000-8000-000000000001','Marce'),
 ('60000000-0000-4000-8000-000000000002','Mel'),
 ('60000000-0000-4000-8000-000000000003','Other');
set local role authenticated;
select set_config('request.jwt.claim.sub','60000000-0000-4000-8000-000000000001',true);
select set_config('test.cash_invite',public.duo_create_invite()::text,true);
select set_config('request.jwt.claim.sub','60000000-0000-4000-8000-000000000002',true);
select public.duo_accept_invite(current_setting('test.cash_invite')::uuid);
select public.duo_add_movement('b-expense','expense',40000,'2098-11-19',true,'ARS','compras','Shared',null);
select public.duo_add_movement('b-income','income',999999,'2098-11-19',false,'ARS',null,'Private salary',null);
select set_config('request.jwt.claim.sub','60000000-0000-4000-8000-000000000001',true);
select public.duo_add_movement('salary','income',200000,'2098-11-19',false,'ARS',null,'Salary',null);
select public.duo_add_movement('sent','transfer',10000,'2098-11-19',true,'ARS',null,'Payment',null);
select public.duo_add_movement('a-shared','expense',100000,'2098-11-19',true,'ARS','compras','Shared',null);
select set_config('request.jwt.claim.sub','60000000-0000-4000-8000-000000000002',true);
select public.duo_add_movement('received','transfer',3000,'2098-11-19',true,'ARS',null,'Payment',null);
select set_config('request.jwt.claim.sub','60000000-0000-4000-8000-000000000001',true);
select public.duo_add_movement('saving','saving',50000,'2098-11-19',false,'ARS',null,'From monthly cash','deposit');
select public.duo_add_saving_without_cash('old-savings',70000,'2098-11-19',false,'Already saved');
select public.duo_add_movement('withdraw','saving',5000,'2098-11-19',false,'ARS',null,'Withdrawal','withdraw');
select public.duo_add_movement('personal-expense','expense',20000,'2098-11-19',false,'ARS','compras','Personal',null);
select public.duo_add_movement('usd-expense','expense-usd',500,'2098-11-19',false,'USD','compras','Dollars',null);
select public.duo_add_movement('future-income','income',1000000,'2098-11-27',false,'ARS',null,'Future',null);
select public.duo_add_movement('future-expense','expense',2000000,'2098-11-27',false,'ARS','compras','Future',null);
select public.duo_set_cash_interest(36.5);
do $$ begin
 assert (public.duo_cash_interest_status()->>'annual_percent')::numeric=36.5;
 assert not exists(select 1 from public.duo_movements where cash_interest_on is not null), 'Activation credited an unclosed day';
 assert not has_function_privilege('public.duo_settle_cash_interest(uuid,date)','execute');
 assert not has_function_privilege('public.duo_settle_all_cash_interest()','execute');
 assert not has_table_privilege('public.duo_cash_interest','update');
 begin
  perform public.duo_set_cash_interest(-1);
  raise exception 'Invalid rate accepted';
 exception when raise_exception then if sqlerrm <> 'duo_invalid_interest_rate' then raise; end if; end;
end $$;
reset role;
-- A private simulated clock keeps the test independent of the execution date.
update public.duo_cash_interest set starts_on='2098-11-19',settled_through='2098-11-18';
select public.duo_settle_cash_interest('60000000-0000-4000-8000-000000000001','2098-11-20');
select public.duo_settle_cash_interest('60000000-0000-4000-8000-000000000001','2098-11-21');
select public.duo_settle_cash_interest('60000000-0000-4000-8000-000000000001','2098-11-21');
do $$ begin
 assert (select count(*) from public.duo_movements where cash_interest_on is not null)=2, 'Duplicate daily income';
 assert (select amount from public.duo_movements where cash_interest_on='2098-11-19')=28, 'Monthly cash components or dates differ';
 assert (select amount from public.duo_movements where cash_interest_on='2098-11-20')=28.03, 'Interest did not compound';
 assert not exists(select 1 from public.duo_movements where cash_interest_on is not null and (kind <> 'income' or currency <> 'ARS' or pair_id is not null or savings_interest_on is not null));
 assert (select sum(case when saving_kind='deposit' then amount else -amount end) from public.duo_movements where kind='saving')=115000, 'Savings changed';
 assert (select count(*) from public.duo_movements where kind='expense')=4, 'Expenses changed';
 assert (select count(*) from public.duo_movements where kind='transfer')=2, 'Transfers changed';
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','60000000-0000-4000-8000-000000000002',true);
do $$ begin
 assert (select count(*) from public.duo_cash_interest)=0, 'Partner saw private rate';
 assert not exists(select 1 from public.duo_movements where cash_interest_on is not null), 'Partner saw private income';
end $$;
select set_config('request.jwt.claim.sub','60000000-0000-4000-8000-000000000001',true);
select public.duo_change_movement((select id from public.duo_movements where cash_interest_on='2098-11-19'),'income',false,50,'2098-11-19','Edited yield',null,false);
select public.duo_change_movement((select id from public.duo_movements where cash_interest_on='2098-11-20'),'income',true,null,null,null,null,false);
reset role;
select public.duo_settle_cash_interest('60000000-0000-4000-8000-000000000001','2098-11-22');
do $$ begin assert (select amount from public.duo_movements where cash_interest_on='2098-11-21')=28.05; end $$;
update public.duo_cash_interest set settled_through='2098-11-18';
select public.duo_settle_cash_interest('60000000-0000-4000-8000-000000000001','2098-11-22');
do $$ begin assert (select count(*) from public.duo_movements where cash_interest_on is not null)=3, 'Deleted income recreated'; end $$;
set local role authenticated;
select public.duo_set_cash_interest(0);
reset role;
select public.duo_settle_cash_interest('60000000-0000-4000-8000-000000000001','2099-01-01');
do $$ begin assert (select count(*) from public.duo_movements where cash_interest_on is not null)=3, 'Paused rate credited income'; end $$;

-- Rate changes must first settle yesterday with the old rate, even across month boundaries.
select set_config('test.cash_today',((clock_timestamp() at time zone 'America/Argentina/Buenos_Aires')::date)::text,true);
set local role authenticated;
select set_config('request.jwt.claim.sub','60000000-0000-4000-8000-000000000003',true);
select public.duo_add_movement('rate-salary','income',200000,current_setting('test.cash_today')::date-1,false,'ARS',null,'Private salary',null);
select public.duo_set_cash_interest(36.5);
reset role;
update public.duo_cash_interest set starts_on=current_setting('test.cash_today')::date-1,settled_through=current_setting('test.cash_today')::date-2 where owner_id='60000000-0000-4000-8000-000000000003';
set local role authenticated;
select public.duo_set_cash_interest(73);
do $$ begin
 assert (select amount from public.duo_movements where cash_interest_on is not null)=200, 'Pending day used the new rate';
 assert (select cash_interest_tna from public.duo_movements where cash_interest_on is not null)=36.5;
 assert (select annual_percent from public.duo_cash_interest)=73;
 assert (select count(*) from public.duo_cash_interest)=1;
end $$;
reset role;
-- Previous-month balances and yields do not invent an income in the new month.
select public.duo_settle_cash_interest('60000000-0000-4000-8000-000000000003','2099-02-02');
do $$ begin
 assert not exists(select 1 from public.duo_movements where owner_id='60000000-0000-4000-8000-000000000003' and cash_interest_on >= '2099-02-01'), 'Cash automatically carried across months';
end $$;
rollback;

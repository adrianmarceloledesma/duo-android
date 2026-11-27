begin;
set local plpgsql.check_asserts=on;
insert into auth.users(id,email) values
 ('71000000-0000-4000-8000-000000000001','open-a@example.invalid'),
 ('71000000-0000-4000-8000-000000000002','open-b@example.invalid'),
 ('71000000-0000-4000-8000-000000000003','open-c@example.invalid'),
 ('71000000-0000-4000-8000-000000000004','open-d@example.invalid'),
 ('71000000-0000-4000-8000-000000000005','open-e@example.invalid');
set local role authenticated;
do $$
declare person uuid; position integer:=0;
begin
 foreach person in array array['71000000-0000-4000-8000-000000000001'::uuid,'71000000-0000-4000-8000-000000000002'::uuid,'71000000-0000-4000-8000-000000000003'::uuid,'71000000-0000-4000-8000-000000000004'::uuid] loop
  position:=position+1;
  perform set_config('request.jwt.claim.sub',person::text,true);
  insert into public.duo_profiles values(person,'New user '||position::text);
  perform public.duo_add_movement('salary','income',10000,'2026-11-26',false,'ARS',null,'Own salary',null);
  perform public.duo_add_movement('private','expense',100,'2026-11-26',false,'ARS','indira','Own expense',null);
  perform public.duo_add_saving_without_cash('private-ars',100,'2026-11-26',false,'Own savings');
  perform public.duo_add_movement('private-usd','saving',20,'2026-11-26',false,'USD',null,'Own dollars','deposit');
  perform public.duo_write_due_date('save',null,'own-card','Own card','2027-01-15',50,'ARS',null);
  perform public.duo_set_personal_interest(0);
  perform public.duo_set_cash_interest(0);
  perform public.duo_set_push_preferences(person,'ExponentPushToken[Public'||position::text||'-Test]',true,true);
 end loop;
end $$;
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000001',true);
select set_config('test.open_invite_ab',public.duo_create_invite()::text,true);
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000002',true);
select public.duo_accept_invite(current_setting('test.open_invite_ab')::uuid);
select set_config('test.open_pair_ab',public.duo_current_pair()::text,true);
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000003',true);
select set_config('test.open_invite_cd',public.duo_create_invite()::text,true);
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000004',true);
select public.duo_accept_invite(current_setting('test.open_invite_cd')::uuid);
select set_config('test.open_pair_cd',public.duo_current_pair()::text,true);

select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000001',true);
select public.duo_add_movement('shared-ab','expense',400,'2026-11-26',true,'ARS','uber','AB shared',null);
select set_config('test.open_ab_expense',(select id::text from public.duo_movements where request_key='shared-ab'),true);
select public.duo_add_saving_without_cash('shared-saving',1000,'2026-11-26',true,'AB savings');
select public.duo_set_shared_interest(0);
select set_config('test.open_private_path',public.duo_reserve_receipt('72000000-0000-4000-8000-000000000001',(select id from public.duo_movements where request_key='private'),null,'Personal.pdf','application/pdf',100),true);
select set_config('test.open_shared_path',public.duo_reserve_receipt('72000000-0000-4000-8000-000000000002',current_setting('test.open_ab_expense')::uuid,null,'Shared.pdf','application/pdf',100),true);
insert into storage.objects(bucket_id,name,metadata) values
 ('duo-receipts',current_setting('test.open_private_path'),'{"size":100,"mimetype":"application/pdf"}'),
 ('duo-receipts',current_setting('test.open_shared_path'),'{"size":100,"mimetype":"application/pdf"}');
select public.duo_finish_receipt('72000000-0000-4000-8000-000000000001');
select public.duo_finish_receipt('72000000-0000-4000-8000-000000000002');

select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000003',true);
select public.duo_add_movement('shared-cd','expense',800,'2026-11-26',true,'ARS','tren','CD shared',null);
select public.duo_add_saving_without_cash('shared-saving',2000,'2026-11-26',true,'CD savings');
select public.duo_set_shared_interest(0);
do $$ begin
 assert (select count(*) from public.duo_expense_receipts)=0, 'Other couple saw receipt metadata';
 assert (select count(*) from storage.objects where bucket_id='duo-receipts')=0, 'Other couple saw files';
 assert not public.duo_can_access_receipt(current_setting('test.open_shared_path'),'read');
 begin
  perform public.duo_change_expense_currency(current_setting('test.open_ab_expense')::uuid,false,1,'uber','Intrusion','2026-11-26',true,'ARS');
  raise exception 'Other couple edited an expense';
 exception when raise_exception then if sqlerrm <> 'duo_expense_unavailable' then raise; end if; end;
 begin
  perform public.duo_reserve_receipt('72000000-0000-4000-8000-000000000099',current_setting('test.open_ab_expense')::uuid,null,'Intrusion.pdf','application/pdf',100);
  raise exception 'Other couple uploaded a receipt';
 exception when raise_exception then if sqlerrm <> 'duo_receipt_forbidden' then raise; end if; end;
end $$;

-- Both couples see their own private data plus only their own shared ledger.
do $$
declare person uuid; position integer:=0; expected_pair uuid;
begin
 foreach person in array array['71000000-0000-4000-8000-000000000001'::uuid,'71000000-0000-4000-8000-000000000002'::uuid,'71000000-0000-4000-8000-000000000003'::uuid,'71000000-0000-4000-8000-000000000004'::uuid] loop
  position:=position+1;
  perform set_config('request.jwt.claim.sub',person::text,true);
  expected_pair:=case when position<=2 then current_setting('test.open_pair_ab')::uuid else current_setting('test.open_pair_cd')::uuid end;
  assert public.duo_current_pair()=expected_pair;
  assert (select count(*) from public.duo_movements)=6, 'Visible ledger is not isolated';
  assert not exists(select 1 from public.duo_movements where pair_id is null and owner_id<>person), 'Private movement leaked';
  assert not exists(select 1 from public.duo_movements where pair_id is not null and pair_id<>expected_pair), 'Other shared ledger leaked';
  assert (select count(*) from public.duo_due_dates)=1;
  assert (select count(*) from public.duo_personal_savings_interest)=1;
  assert (select count(*) from public.duo_cash_interest)=1;
  assert (select count(*) from public.duo_shared_savings_interest)=1;
  assert (select count(*) from public.duo_partner())=1;
  if position=1 then
    assert (select count(*) from storage.objects where bucket_id='duo-receipts')=2;
  elsif position=2 then
    assert (select count(*) from storage.objects where bucket_id='duo-receipts')=1;
    assert not public.duo_can_access_receipt(current_setting('test.open_private_path'),'read');
    assert public.duo_can_access_receipt(current_setting('test.open_shared_path'),'read');
  end if;
 end loop;
end $$;

-- A third account cannot reuse either consumed invite or join either completed couple.
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000005',true);
insert into public.duo_profiles values(auth.uid(),'Unlinked user');
do $$ begin
 assert (select count(*) from public.duo_movements)=0;
 assert (select count(*) from public.duo_due_dates)=0;
 begin
  perform public.duo_accept_invite(current_setting('test.open_invite_ab')::uuid);
  raise exception 'Third user reused an invite';
 exception when raise_exception then if sqlerrm <> 'duo_invalid_invite' then raise; end if; end;
end $$;
reset role;
do $$
declare traffic jsonb[];
begin
 select array_agg(convert_from(body,'UTF8')::jsonb) into traffic from net.http_request_queue
 where url='https://exp.host/--/api/v2/push/send' and convert_from(body,'UTF8') like '%Public%';
 assert cardinality(traffic)=2, 'Wrong number of shared notifications';
 assert exists(select 1 from unnest(traffic) n where n->'to'='["ExponentPushToken[Public2-Test]"]'::jsonb);
 assert exists(select 1 from unnest(traffic) n where n->'to'='["ExponentPushToken[Public4-Test]"]'::jsonb);
 assert not exists(select 1 from unnest(traffic) n where jsonb_array_length(n->'to')<>1), 'Notification crossed couples';
end $$;
rollback;

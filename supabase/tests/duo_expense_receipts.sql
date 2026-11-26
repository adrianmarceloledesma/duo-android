-- Run only against an isolated test database. Storage metadata below simulates API uploads.
begin;
set local plpgsql.check_asserts = on;
insert into auth.users (id, email) values
  ('10000000-0000-4000-8000-000000000001', 'receipt-marce@example.invalid'),
  ('10000000-0000-4000-8000-000000000002', 'receipt-mel@example.invalid'),
  ('10000000-0000-4000-8000-000000000003', 'receipt-outsider@example.invalid');
insert into public.duo_profiles (user_id, display_name) values
  ('10000000-0000-4000-8000-000000000001', 'Marce'),
  ('10000000-0000-4000-8000-000000000002', 'Mel'),
  ('10000000-0000-4000-8000-000000000003', 'Outside');
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select set_config('test.receipt_invite', public.duo_create_invite()::text, true);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
select public.duo_accept_invite(current_setting('test.receipt_invite')::uuid);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select public.duo_add_movement('receipt-private', 'expense', 2000, '2026-10-15', false, 'ARS', 'supermercado', 'Personal original', null);
select public.duo_add_movement('receipt-shared', 'expense-usd', 200, '2026-10-12', true, 'USD', 'compras', 'Compartido original', null);
select public.duo_add_movement('receipt-income', 'income', 200000, '2026-11-01', false, 'ARS', null, 'Sueldo', null);
select public.duo_add_movement('receipt-saving', 'saving', 300, '2026-11-01', false, 'USD', null, 'Anterior', 'deposit');
select set_config('test.private_id', (select id::text from public.duo_movements where request_key = 'receipt-private'), true);
select set_config('test.shared_id', (select id::text from public.duo_movements where request_key = 'receipt-shared'), true);
select set_config('test.financial_before', (select jsonb_agg(to_jsonb(m) order by id)::text from public.duo_movements m), true);
select set_config('test.private_path', public.duo_reserve_receipt('20000000-0000-4000-8000-000000000011', current_setting('test.private_id')::uuid, null, 'Ticket.jpg', 'image/jpeg', 100), true);
select set_config('test.shared_path', public.duo_reserve_receipt('20000000-0000-4000-8000-000000000012', current_setting('test.shared_id')::uuid, null, 'Factura.pdf', 'application/pdf', 200), true);

do $$ begin
  assert (select count(*) from public.duo_expense_receipts) = 0, 'Pending metadata became visible';
  assert not public.duo_can_access_receipt(current_setting('test.private_path'), 'read');
  assert public.duo_can_access_receipt(current_setting('test.private_path'), 'upload');
  begin
    perform public.duo_finish_receipt('20000000-0000-4000-8000-000000000011');
    raise exception 'Finalized without a file';
  exception when raise_exception then if sqlerrm <> 'duo_receipt_upload_missing' then raise; end if; end;
end $$;
insert into storage.objects (bucket_id, name, metadata) values
  ('duo-receipts', current_setting('test.private_path'), '{"size":100,"mimetype":"image/jpeg"}'),
  ('duo-receipts', current_setting('test.shared_path'), '{"size":200,"mimetype":"application/pdf"}');
select public.duo_finish_receipt('20000000-0000-4000-8000-000000000011');
select public.duo_finish_receipt('20000000-0000-4000-8000-000000000012');
select public.duo_finish_receipt('20000000-0000-4000-8000-000000000012');

do $$ begin
  assert (select count(*) from public.duo_expense_receipts) = 2;
  assert (select count(*) from storage.objects where bucket_id = 'duo-receipts') = 2;
  assert not public.duo_can_access_receipt(current_setting('test.private_path'), 'upload'), 'Active file can be overwritten';
  assert not has_table_privilege('public.duo_expense_receipts', 'update');
  assert not has_function_privilege('public.duo_receipt_cleanup_batch()', 'execute');
end $$;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
do $$ begin
  assert (select count(*) from public.duo_expense_receipts) = 1, 'Personal metadata leaked to partner';
  assert (select count(*) from storage.objects where bucket_id = 'duo-receipts') = 1, 'Personal file leaked to partner';
  assert not public.duo_can_access_receipt(current_setting('test.private_path'), 'read');
  assert public.duo_can_access_receipt(current_setting('test.shared_path'), 'read');
  assert not public.duo_can_access_receipt(current_setting('test.shared_path'), 'upload');
  begin
    perform public.duo_remove_receipt('20000000-0000-4000-8000-000000000012');
    raise exception 'Partner removed another owner receipt';
  exception when raise_exception then if sqlerrm <> 'duo_receipt_forbidden' then raise; end if; end;
  begin
    perform public.duo_reserve_receipt('20000000-0000-4000-8000-000000000099', current_setting('test.shared_id')::uuid, '20000000-0000-4000-8000-000000000012', 'Fake.pdf', 'application/pdf', 100);
    raise exception 'Partner replaced another owner receipt';
  exception when raise_exception then if sqlerrm <> 'duo_receipt_forbidden' then raise; end if; end;
  begin
    insert into storage.objects (bucket_id, name, metadata) values ('duo-receipts', 'unreserved-path', '{}');
    raise exception 'Unreserved storage insert succeeded';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);
do $$ begin
  assert (select count(*) from public.duo_expense_receipts) = 0;
  assert (select count(*) from storage.objects where bucket_id = 'duo-receipts') = 0;
end $$;

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select set_config('test.replace_path', public.duo_reserve_receipt('20000000-0000-4000-8000-000000000013', current_setting('test.shared_id')::uuid, '20000000-0000-4000-8000-000000000012', 'Nueva.webp', 'image/webp', 300), true);
select set_config('test.concurrent_path', public.duo_reserve_receipt('20000000-0000-4000-8000-000000000014', current_setting('test.shared_id')::uuid, '20000000-0000-4000-8000-000000000012', 'Otra.webp', 'image/webp', 400), true);
insert into storage.objects (bucket_id, name, metadata) values
  ('duo-receipts', current_setting('test.replace_path'), '{"size":299,"mimetype":"image/webp"}'),
  ('duo-receipts', current_setting('test.concurrent_path'), '{"size":400,"mimetype":"image/webp"}');
do $$ begin
  begin
    perform public.duo_finish_receipt('20000000-0000-4000-8000-000000000013');
    raise exception 'Wrong uploaded size accepted';
  exception when raise_exception then if sqlerrm <> 'duo_receipt_upload_missing' then raise; end if; end;
  assert public.duo_can_access_receipt(current_setting('test.shared_path'), 'read'), 'Failed replacement removed old file';
end $$;
select public.duo_finish_receipt('20000000-0000-4000-8000-000000000014');
do $$ begin
  assert not public.duo_can_access_receipt(current_setting('test.shared_path'), 'read');
  assert public.duo_can_access_receipt(current_setting('test.concurrent_path'), 'read');
  begin
    perform public.duo_finish_receipt('20000000-0000-4000-8000-000000000013');
    raise exception 'Concurrent replacement overwrote newer file';
  exception when raise_exception then if sqlerrm <> 'duo_receipt_conflict' then raise; end if; end;
end $$;
select public.duo_remove_receipt('20000000-0000-4000-8000-000000000014');
select public.duo_remove_receipt('20000000-0000-4000-8000-000000000014');
do $$ begin
  assert (select jsonb_agg(to_jsonb(m) order by id) from public.duo_movements m) = current_setting('test.financial_before')::jsonb,
    'Receipt operation changed an expense, original date, income or saving';
  assert (select count(*) from public.duo_expense_receipts) = 1;
end $$;

-- Sharing changes must immediately affect file and metadata authorization.
select public.duo_change_expense_currency(current_setting('test.private_id')::uuid, false, 2000, 'supermercado', 'Personal original', '2026-10-15', true, 'ARS');
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
do $$ begin assert public.duo_can_access_receipt(current_setting('test.private_path'), 'read'); end $$;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select public.duo_change_expense_currency(current_setting('test.private_id')::uuid, false, 2000, 'supermercado', 'Personal original', '2026-10-15', false, 'ARS');
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
do $$ begin
  assert not public.duo_can_access_receipt(current_setting('test.private_path'), 'read');
  assert (select count(*) from public.duo_expense_receipts) = 0;
end $$;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select public.duo_change_expense_currency(current_setting('test.private_id')::uuid, true, null, null, null, null, null, null);
do $$ begin assert not public.duo_can_access_receipt(current_setting('test.private_path'), 'read'); end $$;
reset role;
update public.duo_expense_receipts set created_at = now() - interval '2 hours' where state = 'reserved';
set local role service_role;
do $$ begin assert (select count(*) from public.duo_receipt_cleanup_batch()) = 4; end $$;
select public.duo_receipt_cleanup_done('20000000-0000-4000-8000-000000000011');
reset role;
do $$ begin
  assert not (select public from storage.buckets where id = 'duo-receipts');
  assert (select cleaned_at is null from public.duo_expense_receipts where id = '20000000-0000-4000-8000-000000000011'), 'Marked clean before API removal';
  assert not exists (select 1 from public.duo_expense_receipts where state <> 'retired');
end $$;
-- Only simulates the Storage API result inside this rollback-only test.
delete from storage.objects where bucket_id = 'duo-receipts';
set local role service_role;
select public.duo_receipt_cleanup_done(id) from public.duo_receipt_cleanup_batch();
do $$ begin assert (select count(*) from public.duo_receipt_cleanup_batch()) = 0; end $$;
reset role;
insert into storage.objects (bucket_id, name, metadata) values ('duo-receipts', current_setting('test.replace_path'), '{"size":300,"mimetype":"image/webp"}');
set local role service_role;
do $$ begin assert (select count(*) from public.duo_receipt_cleanup_batch()) = 1, 'Late upload escaped cleanup'; end $$;
rollback;

-- Run after the receipts migration. Uses the project's existing Supabase services.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'duo_receipt_cleanup_secret') then
    perform vault.create_secret(gen_random_uuid()::text || gen_random_uuid()::text,
      'duo_receipt_cleanup_secret', 'Only authorizes removal of retired Duo receipt files');
  end if;
end;
$$;

select cron.schedule('duo-receipts-cleanup', '17 * * * *', $job$
  select net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/receipt-cleanup',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cleanup-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'duo_receipt_cleanup_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
$job$);

-- Copy this value ONLY into Edge Functions > Secrets > RECEIPT_CLEANUP_SECRET.
-- Never put it in EXPO_PUBLIC_*, source control, the Android app or a chat message.
select decrypted_secret as receipt_cleanup_secret
from vault.decrypted_secrets where name = 'duo_receipt_cleanup_secret';

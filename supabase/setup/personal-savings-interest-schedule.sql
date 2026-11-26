create extension if not exists pg_cron with schema pg_catalog;
-- Supabase Cron uses UTC. 03:05 UTC is 00:05 in Buenos Aires.
select cron.schedule('duo-personal-savings-interest', '5 3 * * *',
  'select public.duo_settle_all_personal_interest();');

-- Runs at 00:05 in Argentina; opening Duo also catches up on any pending days.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('duo-shared-savings-interest', '5 3 * * *', 'select public.duo_settle_all_shared_interest();');

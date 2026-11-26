-- 00:05 in Argentina. Opening Duo also catches up on closed days.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('duo-monthly-cash-interest','5 3 * * *','select public.duo_settle_all_cash_interest();');

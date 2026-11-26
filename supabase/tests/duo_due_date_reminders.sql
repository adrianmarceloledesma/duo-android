begin;
set local plpgsql.check_asserts = on;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'reminders-marce@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'reminders-mel@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
insert into public.duo_profiles values (auth.uid(), 'Marce');
select public.duo_save_due_date_with_reminders(null, 'copy-voley', 'Vóley', date '2026-11-15', null, 'ARS', 'voley', 5, true);
select public.duo_save_due_date_with_reminders(null, 'copy-voley', 'Duplicate', date '2026-11-15', null, 'ARS', 'voley', 3, false);
select public.duo_save_due_date_with_reminders(null, 'repeat-card', 'Tarjeta', date '2027-01-31', null, 'ARS', 'tarjeta-credito', 5, true);
select public.duo_save_due_date(null, 'old-app', 'Vencimiento anterior', date '2026-11-22', null, 'ARS', null);

do $$
declare
  copy_id uuid := (select id from public.duo_due_dates where request_key = 'copy-voley');
  recurring_id uuid := (select id from public.duo_due_dates where request_key = 'repeat-card');
begin
  assert (select payment_window_days = 5 and remind_daily from public.duo_due_dates where id = copy_id);
  assert (select payment_window_days is null and not remind_daily from public.duo_due_dates where request_key = 'old-app');

  perform public.duo_copy_due_dates(date '2026-12-01', array[copy_id], 'reminder-copy');
  assert (select due_on = date '2026-12-15' and due_on - payment_window_days = date '2026-12-10' and remind_daily
    from public.duo_due_dates where source_id = copy_id);

  perform public.duo_repeat_due_dates(date '2027-02-01', array[recurring_id], 'reminder-repeat');
  perform public.duo_generate_due_dates(date '2027-03-01');
  assert (select due_on = date '2027-02-28' and due_on - payment_window_days = date '2027-02-23' and remind_daily
    from public.duo_due_dates where source_id = recurring_id and copied_month = date '2027-02-01');
  assert (select due_on = date '2027-03-31' and payment_window_days = 5 and remind_daily
    from public.duo_due_dates where source_id = recurring_id and copied_month = date '2027-03-01');

  perform public.duo_save_due_date_with_reminders(copy_id, null, 'Vóley', date '2026-11-15', null, 'ARS', 'voley', null, false);
  assert (select payment_window_days is null and not remind_daily from public.duo_due_dates where id = copy_id);

  perform set_config('duo.test_reminder_id', copy_id::text, true);
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
insert into public.duo_profiles values (auth.uid(), 'Mel');
do $$
declare
  target uuid := current_setting('duo.test_reminder_id')::uuid;
begin
  assert not exists (select 1 from public.duo_due_dates where id = target);
  begin
    perform public.duo_save_due_date_with_reminders(target, null, 'Privado', date '2026-11-15', null, 'ARS', null, 4, true);
    raise exception 'Otra cuenta pudo editar un vencimiento privado';
  exception when raise_exception then
    if sqlerrm <> 'duo_due_date_unavailable' then raise; end if;
  end;
end;
$$;

rollback;

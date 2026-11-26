begin;

alter table public.duo_due_dates
  add column payment_window_days integer check (payment_window_days >= 0),
  add column remind_daily boolean not null default false,
  add constraint duo_due_date_daily_window check (not remind_daily or coalesce(payment_window_days, 0) > 0);

alter table public.duo_due_date_schedules
  add column payment_window_days integer check (payment_window_days >= 0),
  add column remind_daily boolean not null default false,
  add constraint duo_due_schedule_daily_window check (not remind_daily or coalesce(payment_window_days, 0) > 0);

-- Copies preserve the length of the payment window. Recurrences use their saved template.
create function public.duo_inherit_due_date_reminders() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'duo_due_dates' then
    if new.due_date_schedule_id is not null then
      select schedule.payment_window_days, schedule.remind_daily
      into new.payment_window_days, new.remind_daily
      from public.duo_due_date_schedules schedule
      where schedule.id = new.due_date_schedule_id and schedule.owner_id = new.owner_id;
      return new;
    end if;
  end if;

  select source.payment_window_days, source.remind_daily
  into new.payment_window_days, new.remind_daily
  from public.duo_due_dates source
  where source.id = new.source_id and source.owner_id = new.owner_id;
  return new;
end;
$$;

create trigger duo_copy_due_date_reminders
before insert on public.duo_due_dates
for each row when (new.source_id is not null)
execute function public.duo_inherit_due_date_reminders();

create trigger duo_copy_due_schedule_reminders
before insert on public.duo_due_date_schedules
for each row
execute function public.duo_inherit_due_date_reminders();

create function public.duo_save_due_date_with_reminders(
  p_id uuid, p_key text, p_title text, p_due_on date, p_amount numeric, p_currency text,
  p_category text, p_payment_window_days integer, p_remind_daily boolean
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then raise exception 'duo_due_date_unavailable'; end if;
  if p_payment_window_days < 0 or (p_remind_daily and coalesce(p_payment_window_days, 0) <= 0) then
    raise exception 'duo_invalid_due_date';
  end if;

  if p_id is null then
    if p_key is null or char_length(p_key) not between 1 and 100 then
      raise exception 'duo_invalid_due_date';
    end if;
    insert into public.duo_due_dates
      (owner_id, title, due_on, amount, currency, category, request_key, payment_window_days, remind_daily)
    values (caller, btrim(p_title), p_due_on, p_amount, p_currency, p_category, p_key,
      p_payment_window_days, coalesce(p_remind_daily, false))
    on conflict (owner_id, request_key) do nothing;
  else
    update public.duo_due_dates set title = btrim(p_title), due_on = p_due_on, amount = p_amount,
      currency = p_currency, category = p_category,
      payment_window_days = p_payment_window_days, remind_daily = coalesce(p_remind_daily, false)
    where id = p_id and owner_id = caller and deleted_at is null;
    if not found then raise exception 'duo_due_date_unavailable'; end if;
  end if;
end;
$$;

revoke all on function public.duo_inherit_due_date_reminders(),
  public.duo_save_due_date_with_reminders(uuid, text, text, date, numeric, text, text, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.duo_save_due_date_with_reminders(uuid, text, text, date, numeric, text, text, integer, boolean)
  to authenticated;

commit;

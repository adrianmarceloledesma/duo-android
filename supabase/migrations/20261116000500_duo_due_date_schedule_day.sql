begin;

alter table public.duo_due_dates
  add column if not exists scheduled_day smallint check (scheduled_day between 1 and 31);

-- Recover the intended day for older copies, including ones copied from a shorter month.
with recursive schedule as (
  select id, owner_id, due_on, coalesce(scheduled_day, extract(day from due_on)::smallint) as scheduled_day
  from public.duo_due_dates
  where source_id is null
  union all
  select child.id, child.owner_id, child.due_on,
    coalesce(child.scheduled_day, case
      when child.due_on = child.copied_month + (
        least(extract(day from parent.due_on)::int, (child.copied_month + interval '1 month')::date - child.copied_month) - 1
      ) then parent.scheduled_day
      else extract(day from child.due_on)::smallint
    end)
  from public.duo_due_dates child
  join schedule parent on parent.id = child.source_id and parent.owner_id = child.owner_id
)
update public.duo_due_dates item
set scheduled_day = schedule.scheduled_day
from schedule
where item.id = schedule.id and item.scheduled_day is null;

update public.duo_due_dates set scheduled_day = extract(day from due_on)::smallint where scheduled_day is null;
alter table public.duo_due_dates alter column scheduled_day set not null;

create or replace function public.duo_set_due_date_schedule_day() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.scheduled_day := coalesce(new.scheduled_day, extract(day from new.due_on)::smallint);
  elsif new.due_on is distinct from old.due_on then
    new.scheduled_day := extract(day from new.due_on)::smallint;
  end if;
  return new;
end;
$$;

drop trigger if exists duo_set_due_date_schedule_day on public.duo_due_dates;
create trigger duo_set_due_date_schedule_day
before insert or update of due_on on public.duo_due_dates
for each row execute function public.duo_set_due_date_schedule_day();

revoke all on function public.duo_set_due_date_schedule_day() from public, anon, authenticated;

create or replace function public.duo_copy_due_dates(p_month date, p_ids uuid[], p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then raise exception 'duo_due_date_unavailable'; end if;
  if p_month is null or not isfinite(p_month) or extract(day from p_month) <> 1 or p_ids is null
    or p_key is null or char_length(p_key) not between 1 and 100
  then raise exception 'duo_invalid_due_date'; end if;

  insert into public.duo_due_dates
    (owner_id, title, due_on, amount, currency, category, scheduled_day, source_id, copied_month, request_key)
  select caller, item.title,
    p_month + (least(item.scheduled_day, (p_month + interval '1 month')::date - p_month) - 1),
    item.amount, item.currency, item.category, item.scheduled_day, item.id, p_month, p_key || ':' || item.id::text
  from public.duo_due_dates item
  where item.owner_id = caller and item.id = any(p_ids) and item.deleted_at is null
    and item.due_on >= (p_month - interval '1 month')::date and item.due_on < p_month
  on conflict do nothing;
end;
$$;

commit;

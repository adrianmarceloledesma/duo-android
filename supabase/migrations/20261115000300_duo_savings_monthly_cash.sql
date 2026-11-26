begin;

alter table public.duo_movements
  add column exclude_from_monthly_cash boolean not null default false,
  add constraint duo_saving_monthly_cash_check
    check (not exclude_from_monthly_cash or (kind = 'saving' and saving_kind = 'deposit' and currency = 'ARS'));

create function public.duo_add_saving_without_cash(
  p_request_key text, p_amount numeric, p_date date, p_shared boolean, p_note text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'duo_profile_required';
  end if;

  -- Use the same caller lock as the existing save path for a retried request.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));
  if exists (
    select 1 from public.duo_movements m where m.owner_id = caller and m.request_key = p_request_key
  ) then
    return;
  end if;

  perform public.duo_add_movement(p_request_key, 'saving', p_amount, p_date, p_shared, 'ARS', null, p_note, 'deposit');
  update public.duo_movements set exclude_from_monthly_cash = true
  where owner_id = caller and request_key = p_request_key;
end;
$$;

revoke all on function public.duo_add_saving_without_cash(text, numeric, date, boolean, text)
  from public, anon, authenticated;
grant execute on function public.duo_add_saving_without_cash(text, numeric, date, boolean, text)
  to authenticated;

commit;

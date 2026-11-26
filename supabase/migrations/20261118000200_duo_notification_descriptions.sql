begin;

alter table public.duo_push_devices
  add column show_description boolean not null default false;

create function public.duo_set_push_preferences(
  p_device_id uuid, p_token text, p_debt_payments boolean, p_shared_expenses boolean, p_show_description boolean
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.duo_set_push_preferences(p_device_id, p_token, p_debt_payments, p_shared_expenses);

  update public.duo_push_devices
  set show_description = coalesce(p_show_description, false)
  where device_id = p_device_id and owner_id = auth.uid();
end;
$$;

create or replace function public.duo_notify_debt_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  recipient record;
  movement_description text := left(nullif(btrim(regexp_replace(new.note, '[[:space:]]+', ' ', 'g')), ''), 140);
  default_body constant text := 'Abrí Duo para ver el movimiento.';
  is_expense boolean := new.kind in ('expense', 'expense-usd');
  is_debt boolean := new.kind in ('debt', 'debt-receivable');
begin
  if new.pair_id is null then return new; end if;

  for recipient in
    select jsonb_agg(destination.expo_token) as tokens, destination.notice_body
    from (
      select device.expo_token,
        coalesce(case when device.show_description then movement_description end, default_body) as notice_body
      from public.duo_pair_members member
      join public.duo_push_devices device on device.owner_id = member.user_id
      where member.pair_id = new.pair_id and member.user_id <> new.owner_id
        and ((is_expense and device.notify_shared_expenses) or
          (not is_expense and member.user_id = new.recipient_id and device.notify_debt_payments))
      limit 100
    ) destination
    group by destination.notice_body
  loop
    begin
      perform net.http_post(
        url := 'https://exp.host/--/api/v2/push/send',
        headers := '{"Content-Type":"application/json","Accept":"application/json"}'::jsonb,
        body := jsonb_build_object(
          'to', recipient.tokens,
          'title', case
            when is_expense then 'Nuevo gasto compartido'
            when is_debt then 'Nueva deuda registrada'
            else 'Pago de deuda registrado'
          end,
          'body', recipient.notice_body,
          'channelId', case when is_expense then 'duo-gastos-compartidos' else 'duo-deudas-pagos' end,
          'priority', 'high',
          'sound', 'default',
          'data', jsonb_build_object('duoType', case when is_expense then 'shared-expense' else 'shared-debt-payment' end)
        )
      );
    exception when others then
      raise log 'No se pudo encolar la notificación de Duo.';
    end;
  end loop;
  return new;
end;
$$;

revoke all on function public.duo_set_push_preferences(uuid, text, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.duo_set_push_preferences(uuid, text, boolean, boolean, boolean) to authenticated;
notify pgrst, 'reload schema';

commit;

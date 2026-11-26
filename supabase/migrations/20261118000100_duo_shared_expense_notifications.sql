begin;

alter table public.duo_push_devices
  add column notify_debt_payments boolean not null default true,
  add column notify_shared_expenses boolean not null default false;

create function public.duo_set_push_preferences(
  p_device_id uuid, p_token text, p_debt_payments boolean, p_shared_expenses boolean
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (coalesce(p_debt_payments, false) or coalesce(p_shared_expenses, false)) then
    perform public.duo_set_push_device(p_device_id, null);
    return;
  end if;

  if p_token is null then raise exception 'duo_push_unavailable'; end if;
  perform public.duo_set_push_device(p_device_id, p_token);

  update public.duo_push_devices
  set notify_debt_payments = coalesce(p_debt_payments, false),
      notify_shared_expenses = coalesce(p_shared_expenses, false)
  where device_id = p_device_id and owner_id = auth.uid();
end;
$$;

create or replace function public.duo_notify_debt_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  tokens jsonb;
  is_expense boolean := new.kind in ('expense', 'expense-usd');
  is_debt boolean := new.kind in ('debt', 'debt-receivable');
begin
  if new.pair_id is null then return new; end if;

  select jsonb_agg(recipient.expo_token) into tokens
  from (
    select device.expo_token
    from public.duo_pair_members member
    join public.duo_push_devices device on device.owner_id = member.user_id
    where member.pair_id = new.pair_id and member.user_id <> new.owner_id
      and ((is_expense and device.notify_shared_expenses) or
        (not is_expense and member.user_id = new.recipient_id and device.notify_debt_payments))
    limit 100
  ) recipient;
  if tokens is null then return new; end if;

  begin
    perform net.http_post(
      url := 'https://exp.host/--/api/v2/push/send',
      headers := '{"Content-Type":"application/json","Accept":"application/json"}'::jsonb,
      body := jsonb_build_object(
        'to', tokens,
        'title', case
          when is_expense then 'Nuevo gasto compartido'
          when is_debt then 'Nueva deuda registrada'
          else 'Pago de deuda registrado'
        end,
        'body', 'Abrí Duo para ver el movimiento.',
        'channelId', case when is_expense then 'duo-gastos-compartidos' else 'duo-deudas-pagos' end,
        'priority', 'high',
        'sound', 'default',
        'data', jsonb_build_object('duoType', case when is_expense then 'shared-expense' else 'shared-debt-payment' end)
      )
    );
  exception when others then
    raise log 'No se pudo encolar la notificación de Duo.';
  end;
  return new;
end;
$$;

create or replace trigger duo_notify_debt_payment
after insert on public.duo_movements
for each row
when (new.pair_id is not null and new.kind in ('expense', 'expense-usd', 'debt', 'debt-receivable', 'transfer', 'transfer-usd'))
execute function public.duo_notify_debt_payment();

revoke all on function public.duo_set_push_preferences(uuid, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.duo_set_push_preferences(uuid, text, boolean, boolean) to authenticated;
notify pgrst, 'reload schema';

commit;

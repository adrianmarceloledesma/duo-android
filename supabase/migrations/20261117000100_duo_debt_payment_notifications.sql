begin;

create extension if not exists pg_net with schema extensions;

create table public.duo_push_devices (
  device_id uuid primary key,
  owner_id uuid not null references public.duo_profiles (user_id) on delete cascade,
  expo_token text not null unique check (
    char_length(expo_token) <= 512 and expo_token ~ '^(ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]+\]$'
  )
);
create index duo_push_devices_owner_idx on public.duo_push_devices (owner_id);
alter table public.duo_push_devices enable row level security;
revoke all on public.duo_push_devices from public, anon, authenticated;

create function public.duo_set_push_device(p_device_id uuid, p_token text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null or p_device_id is null then
    raise exception 'duo_push_unavailable';
  end if;

  if p_token is null then
    delete from public.duo_push_devices where device_id = p_device_id and owner_id = caller;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_token, 2));
  delete from public.duo_push_devices where expo_token = p_token and device_id <> p_device_id;
  insert into public.duo_push_devices (device_id, owner_id, expo_token)
  values (p_device_id, caller, p_token)
  on conflict (device_id) do update set owner_id = excluded.owner_id, expo_token = excluded.expo_token;
end;
$$;

create function public.duo_notify_debt_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  tokens jsonb;
  is_debt boolean := new.kind in ('debt', 'debt-receivable');
begin
  if new.pair_id is null or new.recipient_id is null or new.recipient_id = new.owner_id
    or new.kind not in ('debt', 'debt-receivable', 'transfer', 'transfer-usd')
    or not exists (
      select 1 from public.duo_pair_members member
      where member.pair_id = new.pair_id and member.user_id = new.recipient_id
    )
  then return new; end if;

  select jsonb_agg(device.expo_token) into tokens
  from (select expo_token from public.duo_push_devices where owner_id = new.recipient_id limit 100) device;
  if tokens is null then return new; end if;

  begin
    perform net.http_post(
      url := 'https://exp.host/--/api/v2/push/send',
      headers := '{"Content-Type":"application/json","Accept":"application/json"}'::jsonb,
      body := jsonb_build_object(
        'to', tokens,
        'title', case when is_debt then 'Nueva deuda registrada' else 'Pago de deuda registrado' end,
        'body', 'Abrí Duo para ver el movimiento.',
        'channelId', 'duo-deudas-pagos',
        'sound', 'default',
        'data', jsonb_build_object('duoType', 'shared-debt-payment')
      )
    );
  exception when others then
    raise log 'No se pudo encolar la notificación de deuda de Duo.';
  end;
  return new;
end;
$$;

create trigger duo_notify_debt_payment
after insert on public.duo_movements
for each row
when (new.kind in ('debt', 'debt-receivable', 'transfer', 'transfer-usd'))
execute function public.duo_notify_debt_payment();

revoke all on function public.duo_set_push_device(uuid, text), public.duo_notify_debt_payment()
  from public, anon, authenticated;
grant execute on function public.duo_set_push_device(uuid, text) to authenticated;

commit;

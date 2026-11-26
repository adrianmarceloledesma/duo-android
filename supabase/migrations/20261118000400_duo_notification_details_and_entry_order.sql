begin;

-- Creation time is separate from the editable financial date.
alter table public.duo_movements add column if not exists created_at timestamptz;

create or replace function public.duo_movement_recorded_at(p_key text) returns timestamptz
language sql immutable set search_path = '' as $$
  select case when p_key ~ '^[0-9]{13}[-:]' then
    case when substring(p_key from 1 for 13)::bigint >= 946684800000
      and substring(p_key from 1 for 13)::bigint < 4102444800000
    then to_timestamp(substring(p_key from 1 for 13)::double precision / 1000) end
  end
$$;

-- Existing app request keys include the original save timestamp. Unknown legacy times stay null.
update public.duo_movements set created_at = public.duo_movement_recorded_at(request_key)
where created_at is null and public.duo_movement_recorded_at(request_key) is not null;
alter table public.duo_movements alter column created_at set default clock_timestamp();

create or replace function public.duo_notification_amount(p_amount numeric, p_currency text) returns text
language sql immutable set search_path = '' as $$
  select (case when p_currency = 'USD' then 'US$ ' else '$ ' end) ||
    case when p_amount = trunc(p_amount)
      then replace(to_char(p_amount, 'FM999,999,999,999,990'), ',', '.')
      else translate(to_char(p_amount, 'FM999,999,999,999,990.00'), ',.', '.,')
    end
$$;

create or replace function public.duo_notification_category(p_category text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(('{"supermercado":"Supermercado","verduleria":"Verdulería","panaderia":"Panadería","carniceria":"Carnicería","compras":"Compras","bbva":"BBVA","santander":"Santander","galicia":"Galicia","uala":"Ualá","naranja-x":"Naranja X","banco-nacion":"Banco Nación","banco-provincia":"Banco Provincia","macro":"Macro","icbc":"ICBC","tarjeta-credito":"Otra tarjeta","tuenti":"Tuenti","personal-movil":"Personal","claro":"Claro","movistar":"Movistar","otro-celular":"Otro operador","monotributo":"Monotributo","indira":"Indira","luz":"Edesur","gas":"Metrogas","expensas":"Expensas","agua":"Agua","internet":"Internet","hogar":"Otros de casa","seguro":"Seguro","nafta":"Nafta","patente":"Patente","mecanico":"Mecánico","otros-auto":"Otros de auto","gym":"Gym","voley":"Vóley","padel":"Pádel","youtube":"YouTube","chatgpt":"ChatGPT","netflix":"Netflix","microsoft":"Microsoft","spotify":"Spotify","adobe":"Adobe","salidas":"Salidas","vacaciones":"Vacaciones","salud":"Salud","expedicion-sonrisa":"Expedición Sonrisa","sube":"SUBE","otros":"Otros gastos"}'::jsonb
  )->>p_category, 'Gasto compartido')
$$;

-- Retain the existing preference and device-specific privacy behavior.
alter table public.duo_push_devices add column if not exists show_description boolean not null default false;
create or replace function public.duo_set_push_preferences(
  p_device_id uuid, p_token text, p_debt_payments boolean, p_shared_expenses boolean, p_show_description boolean
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.duo_set_push_preferences(p_device_id, p_token, p_debt_payments, p_shared_expenses);
  update public.duo_push_devices set show_description = coalesce(p_show_description, false)
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
  movement_detail text;
  category_label text;
begin
  if new.pair_id is null then return new; end if;
  if is_expense then
    category_label := public.duo_notification_category(new.category);
    movement_detail := public.duo_notification_amount(new.amount, new.currency) || ' · ' || category_label;
    if movement_description is not null and lower(movement_description) <> lower(category_label) then
      movement_detail := movement_detail || ' · ' || movement_description;
    end if;
  else
    movement_detail := movement_description;
  end if;

  for recipient in
    select jsonb_agg(destination.expo_token) as tokens, destination.notice_body
    from (
      select device.expo_token,
        coalesce(case when device.show_description then movement_detail end, default_body) as notice_body
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
          'title', case when is_expense then 'Nuevo gasto compartido'
            when is_debt then 'Nueva deuda registrada' else 'Pago de deuda registrado' end,
          'body', recipient.notice_body,
          'channelId', case when is_expense then 'duo-gastos-compartidos' else 'duo-deudas-pagos' end,
          'priority', 'high', 'sound', 'default',
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

create or replace trigger duo_notify_debt_payment after insert on public.duo_movements
for each row when (new.pair_id is not null and new.kind in ('expense', 'expense-usd', 'debt', 'debt-receivable', 'transfer', 'transfer-usd'))
execute function public.duo_notify_debt_payment();

revoke all on function public.duo_movement_recorded_at(text), public.duo_notification_amount(numeric, text),
  public.duo_notification_category(text), public.duo_notify_debt_payment(),
  public.duo_set_push_preferences(uuid, text, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.duo_set_push_preferences(uuid, text, boolean, boolean, boolean) to authenticated;

notify pgrst, 'reload schema';
commit;

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('duo-receipts', 'duo-receipts', false, 5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 5242880,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.duo_expense_receipts (
  id uuid primary key,
  expense_id uuid not null references public.duo_movements(id),
  owner_id uuid not null references public.duo_profiles(user_id),
  file_name text not null check (char_length(file_name) between 1 and 140),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  byte_size integer not null check (byte_size between 1 and 5242880),
  object_path text not null unique,
  state text not null default 'reserved' check (state in ('reserved', 'active', 'retired')),
  replaces_id uuid references public.duo_expense_receipts(id),
  created_at timestamptz not null default now(),
  cleaned_at timestamptz
);
create unique index duo_one_receipt_per_expense on public.duo_expense_receipts(expense_id) where state = 'active';
create index duo_receipt_cleanup_idx on public.duo_expense_receipts(state, created_at);
alter table public.duo_expense_receipts enable row level security;
revoke all on public.duo_expense_receipts from public, anon, authenticated;
grant select on public.duo_expense_receipts to authenticated;
create policy duo_receipt_metadata_read on public.duo_expense_receipts for select to authenticated using (
  state = 'active' and exists (
    select 1 from public.duo_movements m where m.id = expense_id
      and m.deleted_at is null and m.kind in ('expense', 'expense-usd')
  )
);

create function public.duo_can_access_receipt(p_path text, p_operation text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.duo_expense_receipts r
    join public.duo_movements m on m.id = r.expense_id
    where r.object_path = p_path and m.kind in ('expense', 'expense-usd')
      and case p_operation
        when 'read' then r.state = 'active' and m.deleted_at is null
          and (m.owner_id = auth.uid() or exists (
            select 1 from public.duo_pair_members member where member.pair_id = m.pair_id and member.user_id = auth.uid()
          ))
        when 'upload' then r.state = 'reserved' and r.created_at > now() - interval '1 hour'
          and r.owner_id = auth.uid() and m.owner_id = auth.uid() and m.deleted_at is null
        when 'delete' then r.state = 'retired' and r.owner_id = auth.uid()
        else false
      end
  )
$$;

create policy duo_receipt_object_read on storage.objects for select to authenticated
using (bucket_id = 'duo-receipts' and public.duo_can_access_receipt(name, 'read'));
create policy duo_receipt_object_upload on storage.objects for insert to authenticated
with check (bucket_id = 'duo-receipts' and public.duo_can_access_receipt(name, 'upload'));
create policy duo_receipt_object_delete on storage.objects for delete to authenticated
using (bucket_id = 'duo-receipts' and public.duo_can_access_receipt(name, 'delete'));

create function public.duo_reserve_receipt(
  p_id uuid, p_expense_id uuid, p_expected_id uuid, p_name text, p_mime text, p_size integer
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  active_id uuid;
  existing public.duo_expense_receipts%rowtype;
  path text;
begin
  perform 1 from public.duo_movements m where m.id = p_expense_id and m.owner_id = caller
    and m.kind in ('expense', 'expense-usd') and m.deleted_at is null for update;
  if not found then raise exception 'duo_receipt_forbidden'; end if;
  select * into existing from public.duo_expense_receipts where id = p_id;
  if found then
    if existing.owner_id <> caller or existing.expense_id <> p_expense_id or existing.state = 'retired'
      or existing.file_name <> p_name or existing.mime_type <> p_mime or existing.byte_size <> p_size
      or existing.replaces_id is distinct from p_expected_id then
      raise exception 'duo_receipt_conflict';
    end if;
    return existing.object_path;
  end if;
  select id into active_id from public.duo_expense_receipts where expense_id = p_expense_id and state = 'active';
  if active_id is distinct from p_expected_id then raise exception 'duo_receipt_conflict'; end if;
  path := caller::text || '/' || p_expense_id::text || '/' || p_id::text;
  insert into public.duo_expense_receipts
    (id, expense_id, owner_id, file_name, mime_type, byte_size, object_path, replaces_id)
  values (p_id, p_expense_id, caller, p_name, p_mime, p_size, path, p_expected_id);
  return path;
end;
$$;

create function public.duo_finish_receipt(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  receipt public.duo_expense_receipts%rowtype;
  active_id uuid;
begin
  select * into receipt from public.duo_expense_receipts where id = p_id and owner_id = auth.uid();
  if not found then raise exception 'duo_receipt_forbidden'; end if;
  perform 1 from public.duo_movements m where m.id = receipt.expense_id and m.owner_id = auth.uid()
    and m.deleted_at is null and m.kind in ('expense', 'expense-usd') for update;
  if not found then raise exception 'duo_receipt_forbidden'; end if;
  select * into receipt from public.duo_expense_receipts where id = p_id for update;
  if receipt.state = 'active' then return; end if;
  if receipt.state <> 'reserved' or receipt.created_at <= now() - interval '1 hour' then
    raise exception 'duo_receipt_expired';
  end if;
  select id into active_id from public.duo_expense_receipts where expense_id = receipt.expense_id and state = 'active';
  if active_id is distinct from receipt.replaces_id then raise exception 'duo_receipt_conflict'; end if;
  if not exists (
    select 1 from storage.objects o where o.bucket_id = 'duo-receipts' and o.name = receipt.object_path
      and (o.metadata->>'size')::bigint = receipt.byte_size and o.metadata->>'mimetype' = receipt.mime_type
  ) then raise exception 'duo_receipt_upload_missing'; end if;
  update public.duo_expense_receipts set state = 'retired' where id = active_id;
  update public.duo_expense_receipts set state = 'active' where id = p_id;
end;
$$;

create function public.duo_remove_receipt(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  receipt public.duo_expense_receipts%rowtype;
begin
  select * into receipt from public.duo_expense_receipts where id = p_id and owner_id = auth.uid();
  if not found then raise exception 'duo_receipt_forbidden'; end if;
  perform 1 from public.duo_movements where id = receipt.expense_id and owner_id = auth.uid() for update;
  if not found then raise exception 'duo_receipt_forbidden'; end if;
  update public.duo_expense_receipts set state = 'retired' where id = p_id;
end;
$$;

create function public.duo_retire_deleted_expense_receipts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is not null then
    update public.duo_expense_receipts set state = 'retired'
    where expense_id = new.id and state <> 'retired';
  end if;
  return new;
end;
$$;
create trigger duo_retire_deleted_expense_receipts after update of deleted_at on public.duo_movements
for each row execute function public.duo_retire_deleted_expense_receipts();

-- Physical deletion is performed by the Storage API. Tombstones also catch late uploads after a timeout.
create function public.duo_receipt_cleanup_batch() returns table (id uuid, object_path text)
language plpgsql security definer set search_path = '' as $$
begin
  update public.duo_expense_receipts r set state = 'retired'
  where r.state = 'reserved' and r.created_at <= now() - interval '1 hour';
  return query
    select r.id, r.object_path from public.duo_expense_receipts r
    where r.state = 'retired' and (r.cleaned_at is null or exists (
      select 1 from storage.objects o where o.bucket_id = 'duo-receipts' and o.name = r.object_path
    )) order by r.created_at limit 100;
end;
$$;
create function public.duo_receipt_cleanup_done(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.duo_expense_receipts r set cleaned_at = now()
  where r.id = p_id and r.state = 'retired' and not exists (
    select 1 from storage.objects o where o.bucket_id = 'duo-receipts' and o.name = r.object_path
  )
$$;

revoke all on function public.duo_can_access_receipt(text, text),
  public.duo_reserve_receipt(uuid, uuid, uuid, text, text, integer),
  public.duo_finish_receipt(uuid), public.duo_remove_receipt(uuid),
  public.duo_retire_deleted_expense_receipts(), public.duo_receipt_cleanup_batch(),
  public.duo_receipt_cleanup_done(uuid) from public, anon, authenticated;
grant execute on function public.duo_can_access_receipt(text, text),
  public.duo_reserve_receipt(uuid, uuid, uuid, text, text, integer),
  public.duo_finish_receipt(uuid), public.duo_remove_receipt(uuid) to authenticated;
grant execute on function public.duo_receipt_cleanup_batch(), public.duo_receipt_cleanup_done(uuid) to service_role;

notify pgrst, 'reload schema';
commit;

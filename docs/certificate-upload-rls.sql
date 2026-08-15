-- PacePack — certificate upload RLS
-- Run in Supabase → SQL Editor. Safe to re-run.
-- Fixes: 403 AccessDenied / "new row violates row-level security policy"
-- when uploading a certificate file onto a runner's result.

-- 1) Public-read certificates bucket
insert into storage.buckets (id, name, public)
values ('certificates', 'certificates', true)
on conflict (id) do update set public = excluded.public;

-- 2) Storage object policies (this is the 403 you are seeing)
drop policy if exists certificates_storage_select on storage.objects;
drop policy if exists certificates_storage_insert on storage.objects;
drop policy if exists certificates_storage_update on storage.objects;
drop policy if exists certificates_storage_delete on storage.objects;

create policy certificates_storage_select on storage.objects
  for select to public
  using (bucket_id = 'certificates');

create policy certificates_storage_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'certificates');

create policy certificates_storage_update on storage.objects
  for update to authenticated
  using (bucket_id = 'certificates')
  with check (bucket_id = 'certificates');

create policy certificates_storage_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'certificates');

-- 3) Attach certificates to a runner result (registrations.certificate_url)
alter table public.registrations
  add column if not exists certificate_url text;

-- 4) user_certificates: keep both url and certificate_url
alter table public.user_certificates
  add column if not exists url text default '',
  add column if not exists certificate_url text,
  add column if not exists title text default '',
  add column if not exists notes text default '';

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_certificates'
      and column_name = 'user_id'
  ) then
    alter table public.user_certificates alter column user_id drop not null;
  end if;
end $$;

alter table public.user_certificates enable row level security;

drop policy if exists user_certificates_select on public.user_certificates;
drop policy if exists user_certificates_insert on public.user_certificates;
drop policy if exists user_certificates_update on public.user_certificates;
drop policy if exists user_certificates_delete on public.user_certificates;
drop policy if exists "Members can view certificates" on public.user_certificates;
drop policy if exists "Members can insert certificates" on public.user_certificates;
drop policy if exists "Moderators can update certificates" on public.user_certificates;
drop policy if exists "Moderators can delete certificates" on public.user_certificates;

create policy user_certificates_select on public.user_certificates
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.group_memberships gm
      where gm.group_id = user_certificates.group_id
        and gm.user_id = auth.uid()
    )
  );

create policy user_certificates_insert on public.user_certificates
  for insert to authenticated
  with check (
    coalesce(user_id, auth.uid()) = auth.uid()
    and exists (
      select 1 from public.group_memberships gm
      where gm.group_id = user_certificates.group_id
        and gm.user_id = auth.uid()
    )
  );

create policy user_certificates_update on public.user_certificates
  for update to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.group_memberships gm
      where gm.group_id = user_certificates.group_id
        and gm.user_id = auth.uid()
        and gm.role in ('moderator', 'admin')
    )
  )
  with check (
    coalesce(user_id, auth.uid()) = auth.uid()
    or exists (
      select 1 from public.group_memberships gm
      where gm.group_id = user_certificates.group_id
        and gm.user_id = auth.uid()
        and gm.role in ('moderator', 'admin')
    )
  );

create policy user_certificates_delete on public.user_certificates
  for delete to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.group_memberships gm
      where gm.group_id = user_certificates.group_id
        and gm.user_id = auth.uid()
        and gm.role in ('moderator', 'admin')
    )
  );

grant select, insert, update, delete on public.user_certificates to authenticated;

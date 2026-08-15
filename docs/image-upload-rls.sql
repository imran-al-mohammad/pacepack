-- PacePack — public images bucket for runner and marathon photos
-- Run in Supabase → SQL Editor. Safe to re-run.

insert into storage.buckets (id, name, public)
values ('images', 'images', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists images_storage_select on storage.objects;
drop policy if exists images_storage_insert on storage.objects;
drop policy if exists images_storage_update on storage.objects;
drop policy if exists images_storage_delete on storage.objects;

create policy images_storage_select on storage.objects
  for select to public
  using (bucket_id = 'images');

create policy images_storage_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'images');

create policy images_storage_update on storage.objects
  for update to authenticated
  using (bucket_id = 'images')
  with check (bucket_id = 'images');

create policy images_storage_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'images');

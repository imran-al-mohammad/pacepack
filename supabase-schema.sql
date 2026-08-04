-- PacePack shared rooms
-- Run this once in Supabase: SQL Editor → New query → Run

create table if not exists public.pacepack_rooms (
  code text primary key,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Keep updated_at fresh
create or replace function public.pacepack_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pacepack_rooms_touch on public.pacepack_rooms;
create trigger pacepack_rooms_touch
  before update on public.pacepack_rooms
  for each row
  execute function public.pacepack_touch_updated_at();

-- Enable realtime so clients get live updates
alter table public.pacepack_rooms replica identity full;

-- Add to supabase_realtime publication if not already there
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'pacepack_rooms'
  ) then
    alter publication supabase_realtime add table public.pacepack_rooms;
  end if;
end $$;

-- Simple access model: room code is the secret.
-- Anyone with the anon key + room code can read/write that room.
-- Fine for a private running group; not for sensitive personal data.
alter table public.pacepack_rooms enable row level security;

drop policy if exists "pacepack_rooms_select" on public.pacepack_rooms;
drop policy if exists "pacepack_rooms_insert" on public.pacepack_rooms;
drop policy if exists "pacepack_rooms_update" on public.pacepack_rooms;
drop policy if exists "pacepack_rooms_delete" on public.pacepack_rooms;

create policy "pacepack_rooms_select"
  on public.pacepack_rooms for select
  to anon, authenticated
  using (true);

create policy "pacepack_rooms_insert"
  on public.pacepack_rooms for insert
  to anon, authenticated
  with check (true);

create policy "pacepack_rooms_update"
  on public.pacepack_rooms for update
  to anon, authenticated
  using (true)
  with check (true);

create policy "pacepack_rooms_delete"
  on public.pacepack_rooms for delete
  to anon, authenticated
  using (true);

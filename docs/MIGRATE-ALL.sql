-- =============================================================================
-- PacePack — COMPREHENSIVE MIGRATION SCRIPT (Part 1 of 3)
-- Run this in Supabase → SQL Editor → New query → Run
-- =============================================================================

-- =============================================================================
-- 1. ADD MISSING COLUMNS TO EXISTING TABLES
-- =============================================================================

-- Profiles table
alter table public.profiles add column if not exists profile_picture_url text default '';
alter table public.profiles add column if not exists must_change_password boolean not null default false;

-- Runners table
alter table public.runners add column if not exists image_url text default '';
alter table public.runners add column if not exists user_id uuid references auth.users (id) on delete set null;
alter table public.runners add column if not exists pace_group text default '';
alter table public.runners add column if not exists join_date date;
alter table public.runners add column if not exists public_profile_enabled boolean not null default false;
alter table public.runners add column if not exists share_slug text;

-- Marathons table
alter table public.marathons add column if not exists image_url text default '';
alter table public.marathons add column if not exists race_time text default '09:00';
alter table public.marathons add column if not exists reg_open_date date default null;
alter table public.marathons add column if not exists reg_close_date date default null;
alter table public.marathons add column if not exists reg_link text default '';

-- Registrations table
alter table public.registrations add column if not exists place_age_group text default '';
alter table public.registrations add column if not exists result_notes text default '';

-- Groups table
alter table public.groups add column if not exists logo_url text default '';

-- =============================================================================
-- 2. CREATE MISSING TABLES
-- =============================================================================

-- Personal Records table
create table if not exists public.personal_records (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  runner_id uuid not null references public.runners (id) on delete cascade,
  distance text not null,
  time_seconds int not null,
  pace_seconds_per_km numeric not null,
  race_date date,
  race_name text default '',
  location text default '',
  is_new_pr boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (runner_id, distance)
);

create index if not exists personal_records_group_idx on public.personal_records (group_id);
create index if not exists personal_records_runner_idx on public.personal_records (runner_id);

-- Runner Badges table
create table if not exists public.runner_badges (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  runner_id uuid not null references public.runners (id) on delete cascade,
  badge_key text not null,
  awarded_at timestamptz not null default now(),
  unique (runner_id, badge_key)
);

create index if not exists runner_badges_group_idx on public.runner_badges (group_id);
create index if not exists runner_badges_runner_idx on public.runner_badges (runner_id);

-- Community Posts table (topics + replies)
create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  runner_id uuid references public.runners (id) on delete set null,
  title text,
  content text not null,
  is_pinned boolean not null default false,
  parent_id uuid references public.community_posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.community_posts add column if not exists is_pinned boolean not null default false;
alter table public.community_posts add column if not exists post_type text not null default 'board';

create index if not exists community_posts_group_idx on public.community_posts (group_id);
create index if not exists community_posts_parent_idx on public.community_posts (parent_id);
create index if not exists community_posts_user_idx on public.community_posts (user_id);
create index if not exists community_posts_created_idx on public.community_posts (group_id, created_at desc);

-- =============================================================================
-- 3. CREATE UNIQUE INDEXES
-- =============================================================================

-- One runner per app member per group
create unique index if not exists runners_group_user_uidx
  on public.runners (group_id, user_id)
  where user_id is not null;

-- Unique share slugs (partial - only where set)
create unique index if not exists runners_share_slug_uidx
  on public.runners (share_slug)
  where share_slug is not null and share_slug <> '';

-- =============================================================================
-- 4. CREATE OR REPLACE HELPER FUNCTIONS
-- =============================================================================

-- updated_at trigger helper
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- updated_at triggers for new tables
drop trigger if exists personal_records_updated on public.personal_records;
create trigger personal_records_updated before update on public.personal_records
  for each row execute function public.set_updated_at();

drop trigger if exists community_posts_updated on public.community_posts;
create trigger community_posts_updated before update on public.community_posts
  for each row execute function public.set_updated_at();

-- updated_at triggers for existing tables (safe to re-run)
drop trigger if exists runners_updated on public.runners;
create trigger runners_updated before update on public.runners
  for each row execute function public.set_updated_at();

drop trigger if exists marathons_updated on public.marathons;
create trigger marathons_updated before update on public.marathons
  for each row execute function public.set_updated_at();

drop trigger if exists registrations_updated on public.registrations;
create trigger registrations_updated before update on public.registrations
  for each row execute function public.set_updated_at();

-- =============================================================================
-- 5. CREATE OR REPLACE RPC FUNCTIONS
-- =============================================================================

-- Group branding fetch (for boot/sign-in screen)
create or replace function public.get_group_branding()
returns table (id uuid, name text, logo_url text)
language sql
stable
security definer
set search_path = public
as $$
  select id, name, logo_url
  from public.groups
  order by created_at
  limit 1;
$$;

grant execute on function public.get_group_branding() to anon, authenticated;

-- VAPID public key fetch (for push notifications)
create or replace function public.get_vapid_public_key()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select 'BKX3deDuUifCoYfOJFhrz/j7dDQIa3AiSvdJS4kGPAZwTJHgCGg8SAf4B3PsrjA4IVaREnj6dlll/7vTDwdb9CM='::text
  where exists (
    select 1 from public.group_memberships
    where user_id = auth.uid()
  );
$$;

grant execute on function public.get_vapid_public_key() to authenticated;

-- =============================================================================
-- 6. ENABLE ROW LEVEL SECURITY ON NEW TABLES
-- =============================================================================

alter table public.personal_records enable row level security;
alter table public.runner_badges enable row level security;
alter table public.community_posts enable row level security;

-- =============================================================================
-- 7. CREATE RLS POLICIES FOR NEW TABLES
-- =============================================================================

-- Personal Records policies
drop policy if exists personal_records_select on public.personal_records;
drop policy if exists personal_records_insert on public.personal_records;
drop policy if exists personal_records_update on public.personal_records;
drop policy if exists personal_records_delete on public.personal_records;

create policy personal_records_select on public.personal_records for select to authenticated
  using (public.is_group_member(group_id));

create policy personal_records_insert on public.personal_records for insert to authenticated
  with check (
    public.has_min_role(group_id, 'member')
    and (
      runner_id in (select id from public.runners where user_id = auth.uid())
      or public.has_min_role(group_id, 'moderator')
    )
  );

create policy personal_records_update on public.personal_records for update to authenticated
  using (
    public.has_min_role(group_id, 'member')
    and (
      runner_id in (select id from public.runners where user_id = auth.uid())
      or public.has_min_role(group_id, 'moderator')
    )
  )
  with check (
    public.has_min_role(group_id, 'member')
    and (
      runner_id in (select id from public.runners where user_id = auth.uid())
      or public.has_min_role(group_id, 'moderator')
    )
  );

create policy personal_records_delete on public.personal_records for delete to authenticated
  using (
    public.has_min_role(group_id, 'member')
    and (
      runner_id in (select id from public.runners where user_id = auth.uid())
      or public.has_min_role(group_id, 'moderator')
    )
  );

-- Runner Badges policies
drop policy if exists runner_badges_select on public.runner_badges;
drop policy if exists runner_badges_insert on public.runner_badges;
drop policy if exists runner_badges_delete on public.runner_badges;

create policy runner_badges_select on public.runner_badges for select to authenticated
  using (public.is_group_member(group_id));

create policy runner_badges_insert on public.runner_badges for insert to authenticated
  with check (public.has_min_role(group_id, 'moderator'));

create policy runner_badges_delete on public.runner_badges for delete to authenticated
  using (public.has_min_role(group_id, 'moderator'));

-- Community Posts policies
drop policy if exists community_posts_select on public.community_posts;
drop policy if exists community_posts_insert on public.community_posts;
drop policy if exists community_posts_update on public.community_posts;
drop policy if exists community_posts_delete on public.community_posts;

create policy community_posts_select on public.community_posts for select to authenticated
  using (public.is_group_member(group_id));

create policy community_posts_insert on public.community_posts for insert to authenticated
  with check (public.has_min_role(group_id, 'member') and (parent_id is not null or coalesce(post_type, 'board') = 'board'));

create policy community_posts_update on public.community_posts for update to authenticated
  using ((coalesce(post_type, 'board') = 'announcement' and public.has_min_role(group_id, 'admin')) or (coalesce(post_type, 'board') <> 'announcement' and (user_id = auth.uid() or public.has_min_role(group_id, 'moderator'))))
  with check ((coalesce(post_type, 'board') = 'announcement' and public.has_min_role(group_id, 'admin')) or (coalesce(post_type, 'board') <> 'announcement' and public.has_min_role(group_id, 'member')));

create policy community_posts_delete on public.community_posts for delete to authenticated
  using ((coalesce(post_type, 'board') = 'announcement' and public.has_min_role(group_id, 'admin')) or (coalesce(post_type, 'board') <> 'announcement' and (user_id = auth.uid() or public.has_min_role(group_id, 'moderator'))));

-- =============================================================================
-- 8. GRANT PERMISSIONS
-- =============================================================================

grant select, insert, update, delete on public.personal_records to authenticated;
grant select, insert, update, delete on public.runner_badges to authenticated;
grant select, insert, update, delete on public.community_posts to authenticated;

-- =============================================================================
-- 9. ENABLE REALTIME FOR NEW TABLES
-- =============================================================================

alter table public.personal_records replica identity full;
alter table public.runner_badges replica identity full;
alter table public.community_posts replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.personal_records;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.runner_badges;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.community_posts;
  exception when duplicate_object then null;
  end;
end $$;

-- =============================================================================
-- 10. NOTIFY POSTGREST TO RELOAD SCHEMA
-- =============================================================================

notify pgrst, 'reload schema';

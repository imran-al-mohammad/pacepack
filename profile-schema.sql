-- =============================================================================
-- PacePack — Public Profile schema
-- Run this in Supabase → SQL Editor → New query → Run
--
-- Adds:
--   personal_records  — best race times per runner per distance
--   runner_badges     — achievement badges (First Marathon, Sub-4, 1000 km Club…)
--   runners.pace_group, join_date, public_profile_enabled, share_slug
-- =============================================================================

-- ─── Personal Records ────────────────────────────────────────────────────────

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

-- ─── Runner Badges ───────────────────────────────────────────────────────────

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

-- ─── Runners: new profile columns ────────────────────────────────────────────

alter table public.runners add column if not exists pace_group text default '';
alter table public.runners add column if not exists join_date date;
alter table public.runners add column if not exists public_profile_enabled boolean not null default false;
alter table public.runners add column if not exists share_slug text;

-- Unique index for share slugs (partial — only where set)
create unique index if not exists runners_share_slug_uidx
  on public.runners (share_slug)
  where share_slug is not null and share_slug <> '';

-- ─── updated_at trigger for new tables ───────────────────────────────────────

drop trigger if exists personal_records_updated on public.personal_records;
create trigger personal_records_updated before update on public.personal_records
  for each row execute function public.set_updated_at();

-- ─── RLS ─────────────────────────────────────────────────────────────────────

alter table public.personal_records enable row level security;
alter table public.runner_badges enable row level security;

-- Personal records: group members can read; members can insert/update their own
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

-- Runner badges: group members can read; moderators+ can award
drop policy if exists runner_badges_select on public.runner_badges;
drop policy if exists runner_badges_insert on public.runner_badges;
drop policy if exists runner_badges_delete on public.runner_badges;

create policy runner_badges_select on public.runner_badges for select to authenticated
  using (public.is_group_member(group_id));

create policy runner_badges_insert on public.runner_badges for insert to authenticated
  with check (public.has_min_role(group_id, 'moderator'));

create policy runner_badges_delete on public.runner_badges for delete to authenticated
  using (public.has_min_role(group_id, 'moderator'));

-- ─── Grants ──────────────────────────────────────────────────────────────────

grant select, insert, update, delete on public.personal_records to authenticated;
grant select, insert, update, delete on public.runner_badges to authenticated;

-- ─── Realtime ────────────────────────────────────────────────────────────────

alter table public.personal_records replica identity full;
alter table public.runner_badges replica identity full;

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
end $$;
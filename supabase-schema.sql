-- =============================================================================
-- PacePack — multi-user online schema (roles: admin, moderator, member)
-- Run this in Supabase → SQL Editor → New query → Run
--
-- Also required in Supabase Dashboard:
--   Authentication → Providers → Email: enabled
--   Authentication → Providers → Email → "Confirm email": OFF (easiest for a club)
--   Project Settings → API: copy URL + anon key into config.js
-- =============================================================================

-- Clean previous simple room table if present (optional; does not touch auth)
-- drop table if exists public.pacepack_rooms cascade;

create extension if not exists "pgcrypto";

-- ─── Groups ──────────────────────────────────────────────────────────────────

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists groups_invite_code_idx on public.groups (invite_code);

-- ─── Profiles (1:1 with auth.users) ──────────────────────────────────────────

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  email text,
  user_type text not null default 'member' check (user_type in ('admin', 'moderator', 'member')),
  group_id uuid references public.groups (id) on delete set null,
  profile_picture_url text default '',
  password text default '',
  created_at timestamptz not null default now()
);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id,
    display_name,
    email,
    user_type,
    group_id,
    profile_picture_url,
    password
  )
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1), 'Runner'),
    new.email,
    case when not exists (select 1 from public.profiles where user_type = 'admin') then 'admin' else 'member' end,
    nullif(new.raw_user_meta_data->>'group_id', '')::uuid,
    coalesce(new.raw_user_meta_data->>'profile_picture_url', ''),
    coalesce(new.raw_user_meta_data->>'password', '')
  )
  on conflict (id) do update
    set email = excluded.email,
        profile_picture_url = coalesce(excluded.profile_picture_url, public.profiles.profile_picture_url),
        password = coalesce(excluded.password, public.profiles.password);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── Memberships + roles ─────────────────────────────────────────────────────

create table if not exists public.group_memberships (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'moderator', 'member')),
  created_at timestamptz not null default now(),
  unique (group_id, user_id)
);

create index if not exists group_memberships_user_idx on public.group_memberships (user_id);
create index if not exists group_memberships_group_idx on public.group_memberships (group_id);

-- ─── Runners (people tracked in the club) ────────────────────────────────────

create table if not exists public.runners (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  name text not null,
  email text default '',
  phone text default '',
  notes text default '',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists runners_group_idx on public.runners (group_id);

-- ─── Marathons / races ───────────────────────────────────────────────────────

create table if not exists public.marathons (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  name text not null,
  race_date date not null,
  location text default '',
  image_url text default '',
  distance text default 'Marathon',
  notes text default '',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marathons_group_idx on public.marathons (group_id);
create index if not exists marathons_date_idx on public.marathons (race_date);

-- ─── Registrations + results ─────────────────────────────────────────────────

create table if not exists public.registrations (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  marathon_id uuid not null references public.marathons (id) on delete cascade,
  runner_id uuid not null references public.runners (id) on delete cascade,
  status text not null default 'registered'
    check (status in ('interested', 'registered', 'waitlisted', 'completed', 'dns', 'dnf')),
  bib text default '',
  notes text default '',
  gun_time text default '',
  chip_time text default '',
  place_overall text default '',
  place_gender text default '',
  place_age_group text default '',
  is_pr boolean not null default false,
  result_notes text default '',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (marathon_id, runner_id)
);

create index if not exists registrations_group_idx on public.registrations (group_id);
create index if not exists registrations_marathon_idx on public.registrations (marathon_id);
create index if not exists registrations_runner_idx on public.registrations (runner_id);

-- ─── updated_at helper ───────────────────────────────────────────────────────

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists runners_updated on public.runners;
create trigger runners_updated before update on public.runners
  for each row execute function public.set_updated_at();

drop trigger if exists marathons_updated on public.marathons;
create trigger marathons_updated before update on public.marathons
  for each row execute function public.set_updated_at();

drop trigger if exists registrations_updated on public.registrations;
create trigger registrations_updated before update on public.registrations
  for each row execute function public.set_updated_at();

-- ─── Role helpers (security definer — avoids RLS recursion) ──────────────────

create or replace function public.is_group_member(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.group_memberships
    where group_id = p_group_id and user_id = auth.uid()
  );
$$;

create or replace function public.my_role(p_group_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.group_memberships
  where group_id = p_group_id and user_id = auth.uid()
  limit 1;
$$;

create or replace function public.has_min_role(p_group_id uuid, p_min text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r text;
  rank_me int;
  rank_need int;
begin
  select role into r from public.group_memberships
  where group_id = p_group_id and user_id = auth.uid();
  if r is null then return false; end if;

  rank_me := case r
    when 'admin' then 3
    when 'moderator' then 2
    when 'member' then 1
    else 0 end;

  rank_need := case p_min
    when 'admin' then 3
    when 'moderator' then 2
    when 'member' then 1
    else 99 end;

  return rank_me >= rank_need;
end;
$$;

-- Generate invite codes
create or replace function public.generate_invite_code()
returns text
language plpgsql
as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
  i int;
begin
  for i in 1..8 loop
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return result;
end;
$$;

-- Create group + make caller admin
create or replace function public.create_group(p_name text)
returns public.groups
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.groups;
  code text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Group name required';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and user_type = 'admin') then
    raise exception 'Only admins can create groups';
  end if;

  loop
    code := public.generate_invite_code();
    exit when not exists (select 1 from public.groups where invite_code = code);
  end loop;

  insert into public.groups (name, invite_code)
  values (trim(p_name), code)
  returning * into g;

  insert into public.group_memberships (group_id, user_id, role)
  values (g.id, auth.uid(), 'admin');

  update public.profiles
  set group_id = g.id
  where id = auth.uid();

  return g;
end;
$$;

-- Join group by invite code (default role: member)
create or replace function public.join_group(p_code text)
returns public.groups
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.groups;
  code text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  code := upper(trim(p_code));
  select * into g from public.groups where invite_code = code;
  if g.id is null then
    raise exception 'Invalid invite code';
  end if;

  insert into public.group_memberships (group_id, user_id, role)
  values (g.id, auth.uid(), 'member')
  on conflict (group_id, user_id) do nothing;

  return g;
end;
$$;

-- Admin: change someone's role
create or replace function public.set_member_role(p_group_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_count int;
  target_role text;
begin
  if not public.has_min_role(p_group_id, 'admin') then
    raise exception 'Only admins can change roles';
  end if;
  if p_role not in ('admin', 'moderator', 'member') then
    raise exception 'Invalid role';
  end if;

  select role into target_role from public.group_memberships
  where group_id = p_group_id and user_id = p_user_id;
  if target_role is null then
    raise exception 'User is not in this group';
  end if;

  -- Prevent removing the last admin
  if target_role = 'admin' and p_role <> 'admin' then
    select count(*) into admin_count from public.group_memberships
    where group_id = p_group_id and role = 'admin';
    if admin_count <= 1 then
      raise exception 'Cannot demote the last admin';
    end if;
  end if;

  update public.group_memberships
  set role = p_role
  where group_id = p_group_id and user_id = p_user_id;
end;
$$;

-- Admin: remove a member from the group
create or replace function public.remove_group_member(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_role text;
  admin_count int;
begin
  if not public.has_min_role(p_group_id, 'admin') then
    raise exception 'Only admins can remove members';
  end if;

  select role into target_role from public.group_memberships
  where group_id = p_group_id and user_id = p_user_id;
  if target_role is null then
    raise exception 'User is not in this group';
  end if;

  if target_role = 'admin' then
    select count(*) into admin_count from public.group_memberships
    where group_id = p_group_id and role = 'admin';
    if admin_count <= 1 then
      raise exception 'Cannot remove the last admin';
    end if;
  end if;

  delete from public.group_memberships
  where group_id = p_group_id and user_id = p_user_id;
end;
$$;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.groups to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.group_memberships to authenticated;
grant select, insert, update, delete on public.runners to authenticated;
grant select, insert, update, delete on public.marathons to authenticated;
grant select, insert, update, delete on public.registrations to authenticated;

grant execute on function public.create_group(text) to authenticated;
grant execute on function public.join_group(text) to authenticated;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;
grant execute on function public.is_group_member(uuid) to authenticated, anon;
grant execute on function public.my_role(uuid) to authenticated, anon;
grant execute on function public.has_min_role(uuid, text) to authenticated, anon;

-- ─── Row Level Security ──────────────────────────────────────────────────────

alter table public.groups enable row level security;
alter table public.profiles enable row level security;
alter table public.group_memberships enable row level security;
alter table public.runners enable row level security;
alter table public.marathons enable row level security;
alter table public.registrations enable row level security;

-- Profiles
drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists profiles_insert on public.profiles;

create policy profiles_select on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1 from public.group_memberships gm1
      join public.group_memberships gm2 on gm1.group_id = gm2.group_id
      where gm1.user_id = auth.uid() and gm2.user_id = profiles.id
    )
  );

create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = auth.uid());

create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Groups: members can read; admins can update name/code
drop policy if exists groups_select on public.groups;
drop policy if exists groups_update on public.groups;

create policy groups_select on public.groups for select to authenticated
  using (public.is_group_member(id));

create policy groups_update on public.groups for update to authenticated
  using (public.has_min_role(id, 'admin'))
  with check (public.has_min_role(id, 'admin'));

-- Memberships
drop policy if exists memberships_select on public.group_memberships;
drop policy if exists memberships_insert on public.group_memberships;
drop policy if exists memberships_update on public.group_memberships;
drop policy if exists memberships_delete on public.group_memberships;

create policy memberships_select on public.group_memberships for select to authenticated
  using (public.is_group_member(group_id) or user_id = auth.uid());

-- Inserts go through security definer RPCs (create_group / join_group)
-- Allow admins to insert memberships directly if needed
create policy memberships_insert on public.group_memberships for insert to authenticated
  with check (public.has_min_role(group_id, 'admin') or user_id = auth.uid());

create policy memberships_update on public.group_memberships for update to authenticated
  using (public.has_min_role(group_id, 'admin'))
  with check (public.has_min_role(group_id, 'admin'));

create policy memberships_delete on public.group_memberships for delete to authenticated
  using (public.has_min_role(group_id, 'admin') or user_id = auth.uid());

-- Runners
-- Member+: read
-- Moderator+: insert/update/delete
-- Member can also insert (add teammates) and update (fix contact) — club-friendly
drop policy if exists runners_select on public.runners;
drop policy if exists runners_insert on public.runners;
drop policy if exists runners_update on public.runners;
drop policy if exists runners_delete on public.runners;

create policy runners_select on public.runners for select to authenticated
  using (public.is_group_member(group_id));

create policy runners_insert on public.runners for insert to authenticated
  with check (public.has_min_role(group_id, 'member'));

create policy runners_update on public.runners for update to authenticated
  using (public.has_min_role(group_id, 'member'))
  with check (public.has_min_role(group_id, 'member'));

create policy runners_delete on public.runners for delete to authenticated
  using (public.has_min_role(group_id, 'moderator'));

-- Marathons
-- Member: read
-- Moderator+: write/delete
-- Member may insert new races (club-friendly) but only moderator+ can delete
drop policy if exists marathons_select on public.marathons;
drop policy if exists marathons_insert on public.marathons;
drop policy if exists marathons_update on public.marathons;
drop policy if exists marathons_delete on public.marathons;

create policy marathons_select on public.marathons for select to authenticated
  using (public.is_group_member(group_id));

create policy marathons_insert on public.marathons for insert to authenticated
  with check (public.has_min_role(group_id, 'member'));

create policy marathons_update on public.marathons for update to authenticated
  using (public.has_min_role(group_id, 'member'))
  with check (public.has_min_role(group_id, 'member'));

create policy marathons_delete on public.marathons for delete to authenticated
  using (public.has_min_role(group_id, 'moderator'));

-- Registrations / results
-- Everyone in group can add/update results; only moderator+ can delete
drop policy if exists registrations_select on public.registrations;
drop policy if exists registrations_insert on public.registrations;
drop policy if exists registrations_update on public.registrations;
drop policy if exists registrations_delete on public.registrations;

create policy registrations_select on public.registrations for select to authenticated
  using (public.is_group_member(group_id));

create policy registrations_insert on public.registrations for insert to authenticated
  with check (public.has_min_role(group_id, 'member'));

create policy registrations_update on public.registrations for update to authenticated
  using (public.has_min_role(group_id, 'member'))
  with check (public.has_min_role(group_id, 'member'));

create policy registrations_delete on public.registrations for delete to authenticated
  using (public.has_min_role(group_id, 'moderator'));

-- ─── Realtime ────────────────────────────────────────────────────────────────

alter table public.runners replica identity full;
alter table public.marathons replica identity full;
alter table public.registrations replica identity full;
alter table public.group_memberships replica identity full;
alter table public.groups replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.runners;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.marathons;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.registrations;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.group_memberships;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.groups;
  exception when duplicate_object then null;
  end;
end $$;

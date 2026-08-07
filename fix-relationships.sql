-- =============================================================================
-- PacePack — FIX: missing relationships / grants / RLS helpers
-- Run this in Supabase → SQL Editor if you see:
--   "Could not find a relationship between ..."
--   "group relationship is not there"
--   empty group after create/join
-- =============================================================================

create extension if not exists "pgcrypto";

-- ─── Ensure core tables exist ────────────────────────────────────────────────

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  email text,
  created_at timestamptz not null default now()
);

-- Optional columns used by admin user-creation / full schema
alter table public.profiles add column if not exists group_id uuid;
alter table public.profiles add column if not exists user_type text default 'member';

create table if not exists public.group_memberships (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  user_id uuid not null,
  role text not null check (role in ('admin', 'moderator', 'member')),
  created_at timestamptz not null default now(),
  unique (group_id, user_id)
);

create table if not exists public.runners (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  name text not null,
  email text default '',
  phone text default '',
  image_url text default '',
  notes text default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.runners add column if not exists image_url text default '';

create table if not exists public.marathons (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  name text not null,
  race_date date not null,
  location text default '',
  image_url text default '',
  distance text default 'Marathon',
  notes text default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.marathons add column if not exists image_url text default '';

create table if not exists public.registrations (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  marathon_id uuid not null,
  runner_id uuid not null,
  status text not null default 'registered',
  bib text default '',
  notes text default '',
  gun_time text default '',
  chip_time text default '',
  place_overall text default '',
  place_gender text default '',
  place_age_group text default '',
  is_pr boolean not null default false,
  result_notes text default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (marathon_id, runner_id)
);

-- ─── Foreign keys (safe re-run) ──────────────────────────────────────────────

do $$
begin
  -- memberships → groups
  if not exists (
    select 1 from pg_constraint where conname = 'group_memberships_group_id_fkey'
  ) then
    alter table public.group_memberships
      add constraint group_memberships_group_id_fkey
      foreign key (group_id) references public.groups (id) on delete cascade;
  end if;

  -- memberships → auth.users
  if not exists (
    select 1 from pg_constraint where conname = 'group_memberships_user_id_fkey'
  ) then
    alter table public.group_memberships
      add constraint group_memberships_user_id_fkey
      foreign key (user_id) references auth.users (id) on delete cascade;
  end if;

  -- memberships → profiles (helps PostgREST embeds; optional but useful)
  if not exists (
    select 1 from pg_constraint where conname = 'group_memberships_user_profile_fkey'
  ) then
    -- only add if all user_ids already have profiles (or table empty)
    begin
      alter table public.group_memberships
        add constraint group_memberships_user_profile_fkey
        foreign key (user_id) references public.profiles (id) on delete cascade;
    exception when others then
      raise notice 'Skipped profiles FK (create profiles for existing users first): %', sqlerrm;
    end;
  end if;

  -- runners → groups
  if not exists (select 1 from pg_constraint where conname = 'runners_group_id_fkey') then
    alter table public.runners
      add constraint runners_group_id_fkey
      foreign key (group_id) references public.groups (id) on delete cascade;
  end if;

  -- marathons → groups
  if not exists (select 1 from pg_constraint where conname = 'marathons_group_id_fkey') then
    alter table public.marathons
      add constraint marathons_group_id_fkey
      foreign key (group_id) references public.groups (id) on delete cascade;
  end if;

  -- registrations FKs
  if not exists (select 1 from pg_constraint where conname = 'registrations_group_id_fkey') then
    alter table public.registrations
      add constraint registrations_group_id_fkey
      foreign key (group_id) references public.groups (id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'registrations_marathon_id_fkey') then
    alter table public.registrations
      add constraint registrations_marathon_id_fkey
      foreign key (marathon_id) references public.marathons (id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'registrations_runner_id_fkey') then
    alter table public.registrations
      add constraint registrations_runner_id_fkey
      foreign key (runner_id) references public.runners (id) on delete cascade;
  end if;
end $$;

-- ─── Grants (often missing if tables were created without them) ──────────────

grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on public.groups to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.group_memberships to authenticated;
grant select, insert, update, delete on public.runners to authenticated;
grant select, insert, update, delete on public.marathons to authenticated;
grant select, insert, update, delete on public.registrations to authenticated;

-- ─── Role helpers ────────────────────────────────────────────────────────────

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

  rank_me := case r when 'admin' then 3 when 'moderator' then 2 when 'member' then 1 else 0 end;
  rank_need := case p_min when 'admin' then 3 when 'moderator' then 2 when 'member' then 1 else 99 end;
  return rank_me >= rank_need;
end;
$$;

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

  -- ensure profile exists
  insert into public.profiles (id, display_name, email)
  values (
    auth.uid(),
    coalesce((select display_name from public.profiles where id = auth.uid()), 'Admin'),
    (select email from auth.users where id = auth.uid())
  )
  on conflict (id) do nothing;

  loop
    code := public.generate_invite_code();
    exit when not exists (select 1 from public.groups where invite_code = code);
  end loop;

  insert into public.groups (name, invite_code)
  values (trim(p_name), code)
  returning * into g;

  insert into public.group_memberships (group_id, user_id, role)
  values (g.id, auth.uid(), 'admin')
  on conflict (group_id, user_id) do update set role = 'admin';

  return g;
end;
$$;

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

  insert into public.profiles (id, display_name, email)
  values (
    auth.uid(),
    coalesce((select raw_user_meta_data->>'display_name' from auth.users where id = auth.uid()), 'Runner'),
    (select email from auth.users where id = auth.uid())
  )
  on conflict (id) do nothing;

  insert into public.group_memberships (group_id, user_id, role)
  values (g.id, auth.uid(), 'member')
  on conflict (group_id, user_id) do nothing;

  return g;
end;
$$;

-- Admin: add an existing auth user to the group (used after admin creates a login)
create or replace function public.add_group_member(p_group_id uuid, p_user_id uuid, p_role text default 'member')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  u_email text;
  u_name text;
begin
  if not public.has_min_role(p_group_id, 'admin') then
    raise exception 'Only admins can add members';
  end if;
  if p_role not in ('admin', 'moderator', 'member') then
    raise exception 'Invalid role';
  end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'User does not exist';
  end if;

  select email, coalesce(raw_user_meta_data->>'display_name', split_part(email, '@', 1), 'Runner')
    into u_email, u_name
  from auth.users
  where id = p_user_id;

  insert into public.profiles (id, display_name, email, group_id)
  values (p_user_id, u_name, u_email, p_group_id)
  on conflict (id) do update
    set email = coalesce(excluded.email, public.profiles.email),
        display_name = case
          when coalesce(public.profiles.display_name, '') in ('', 'Runner', 'User')
            then excluded.display_name
          else public.profiles.display_name
        end,
        group_id = coalesce(public.profiles.group_id, excluded.group_id);

  insert into public.group_memberships (group_id, user_id, role)
  values (p_group_id, p_user_id, p_role)
  on conflict (group_id, user_id) do update set role = excluded.role;
end;
$$;

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

grant execute on function public.create_group(text) to authenticated;
grant execute on function public.join_group(text) to authenticated;
grant execute on function public.add_group_member(uuid, uuid, text) to authenticated;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;
grant execute on function public.is_group_member(uuid) to authenticated, anon;
grant execute on function public.my_role(uuid) to authenticated, anon;
grant execute on function public.has_min_role(uuid, text) to authenticated, anon;

-- ─── RLS ─────────────────────────────────────────────────────────────────────

alter table public.groups enable row level security;
alter table public.profiles enable row level security;
alter table public.group_memberships enable row level security;
alter table public.runners enable row level security;
alter table public.marathons enable row level security;
alter table public.registrations enable row level security;

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

drop policy if exists groups_select on public.groups;
drop policy if exists groups_update on public.groups;
create policy groups_select on public.groups for select to authenticated
  using (public.is_group_member(id));
create policy groups_update on public.groups for update to authenticated
  using (public.has_min_role(id, 'admin'))
  with check (public.has_min_role(id, 'admin'));

drop policy if exists memberships_select on public.group_memberships;
drop policy if exists memberships_insert on public.group_memberships;
drop policy if exists memberships_update on public.group_memberships;
drop policy if exists memberships_delete on public.group_memberships;
create policy memberships_select on public.group_memberships for select to authenticated
  using (public.is_group_member(group_id) or user_id = auth.uid());
create policy memberships_insert on public.group_memberships for insert to authenticated
  with check (public.has_min_role(group_id, 'admin') or user_id = auth.uid());
create policy memberships_update on public.group_memberships for update to authenticated
  using (public.has_min_role(group_id, 'admin'))
  with check (public.has_min_role(group_id, 'admin'));
create policy memberships_delete on public.group_memberships for delete to authenticated
  using (public.has_min_role(group_id, 'admin') or user_id = auth.uid());

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

-- Profile trigger for new signups
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1), 'Runner'),
    new.email
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for existing auth users
insert into public.profiles (id, display_name, email)
select
  u.id,
  coalesce(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1), 'Runner'),
  u.email
from auth.users u
on conflict (id) do nothing;

notify pgrst, 'reload schema';

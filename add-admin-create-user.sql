-- =============================================================================
-- PacePack — allow Admin to create users (add_group_member RPC)
-- Run once in Supabase → SQL Editor if you already applied an older schema.
-- =============================================================================

alter table public.profiles add column if not exists group_id uuid;
alter table public.profiles add column if not exists user_type text default 'member';

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

grant execute on function public.add_group_member(uuid, uuid, text) to authenticated;

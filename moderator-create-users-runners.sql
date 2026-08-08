-- PacePack — allow moderators and admins to add users and runners.
-- Run once in the Supabase SQL Editor for an existing project.

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
  if not public.has_min_role(p_group_id, 'moderator') then
    raise exception 'Only moderators and admins can add members';
  end if;
  if p_role not in ('admin', 'moderator', 'member') then
    raise exception 'Invalid role';
  end if;
  if p_role <> 'member' and not public.has_min_role(p_group_id, 'admin') then
    raise exception 'Moderators can only add member users';
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

drop policy if exists runners_insert on public.runners;
create policy runners_insert on public.runners for insert to authenticated
  with check (public.has_min_role(group_id, 'moderator'));

grant execute on function public.add_group_member(uuid, uuid, text) to authenticated;

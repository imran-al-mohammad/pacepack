-- =============================================================================
-- PacePack — public group branding fetch
-- Run this in Supabase → SQL Editor → New query → Run
--
-- Allows the boot/loading screen and sign-in page to show the group logo
-- even before a user is authenticated. Only exposes id, name, and logo_url
-- (no invite codes or other sensitive fields).
-- =============================================================================

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
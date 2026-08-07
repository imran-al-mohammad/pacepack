-- =============================================================================
-- PacePack — image/logo columns + member runners + password-change flag
-- Run once in Supabase → SQL Editor if columns are missing.
-- =============================================================================

alter table public.runners add column if not exists image_url text default '';
alter table public.marathons add column if not exists image_url text default '';
alter table public.marathons add column if not exists race_time text default '09:00';
alter table public.runners add column if not exists user_id uuid;
alter table public.profiles add column if not exists profile_picture_url text default '';
alter table public.profiles add column if not exists must_change_password boolean default false;
alter table public.groups add column if not exists logo_url text default '';

-- One runner per app member per group (optional unique link)
create unique index if not exists runners_group_user_uidx
  on public.runners (group_id, user_id)
  where user_id is not null;

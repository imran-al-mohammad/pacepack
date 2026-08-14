-- PacePack FastAPI-era compatibility migration.
-- Safe to rerun. Does not drop legacy tables (marathons, registrations,
-- user_certificates). New names are added as views or complementary tables.

create extension if not exists "pgcrypto";

-- ─── Ensure shared helper exists ─────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ─── Legacy columns used by the new services ─────────────────────────────────
alter table public.runners add column if not exists join_date date;
alter table public.runners add column if not exists pace_group text default '';
alter table public.runners add column if not exists public_profile_enabled boolean not null default false;
alter table public.runners add column if not exists share_slug text;
alter table public.registrations add column if not exists race_distance text;
alter table public.registrations add column if not exists certificate_url text;
alter table public.community_posts add column if not exists post_type text not null default 'board';
alter table public.community_posts add column if not exists event_key text;

create unique index if not exists community_posts_event_key_uidx
  on public.community_posts (group_id, event_key)
  where event_key is not null and event_key <> '';

-- ─── Compatibility views (read path for new names) ───────────────────────────
create or replace view public.races as
  select
    id,
    group_id,
    name,
    race_date,
    race_time,
    location,
    image_url,
    distance,
    notes,
    reg_open_date,
    reg_close_date,
    reg_link,
    created_by,
    created_at,
    updated_at
  from public.marathons;

comment on view public.races is
  'Compatibility view over public.marathons. Legacy table remains source of truth.';

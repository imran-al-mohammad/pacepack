-- =============================================================================
-- PacePack — add optional image_url on runners and marathons
-- Run once in Supabase → SQL Editor if either column is missing.
-- =============================================================================

alter table public.runners add column if not exists image_url text default '';
alter table public.marathons add column if not exists image_url text default '';

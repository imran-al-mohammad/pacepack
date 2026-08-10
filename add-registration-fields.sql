-- =============================================================================
-- PacePack — registration fields for marathons
-- Run once in Supabase → SQL Editor if columns are missing.
-- Adds registration open/close dates and a registration link to races.
-- =============================================================================

alter table public.marathons add column if not exists reg_open_date date default null;
alter table public.marathons add column if not exists reg_close_date date default null;
alter table public.marathons add column if not exists reg_link text default '';

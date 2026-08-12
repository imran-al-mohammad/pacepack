-- PacePack achievement automation compatibility migration.
-- Run after notifications-schema.sql on existing projects.
-- The Python job performs the data-driven calculations with a service-role key.

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('new_marathon', 'result_added', 'race_reminder', 'pr_detected', 'badge_earned'));

create index if not exists notifications_achievement_idx
  on public.notifications (group_id, type, created_at desc)
  where type in ('pr_detected', 'badge_earned');

-- Achievement rows are service-generated. Keep them readable to members but
-- remove client-side insert/update/delete paths so users cannot self-award PRs
-- or badges. The scheduled job uses the Supabase service role, which bypasses
-- RLS and remains outside the browser.
drop policy if exists personal_records_insert on public.personal_records;
drop policy if exists personal_records_update on public.personal_records;
drop policy if exists personal_records_delete on public.personal_records;
drop policy if exists runner_badges_insert on public.runner_badges;
drop policy if exists runner_badges_delete on public.runner_badges;

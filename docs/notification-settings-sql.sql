-- =============================================================================
-- PacePack — Dynamic Notification Settings & Scheduled Cadence
-- Run this in Supabase → SQL Editor → New query → Run
--
-- Provides:
--   1. group_notification_settings  — per-group enable/disable toggles for each
--      notification channel (new race, result added, race reminders, registration
--      nudge, race announcement).
--   2. notification_schedules       — multi-point reminder cadence (e.g. 14 days
--      before, 7 days before, 1 day before, 1 hour before). Each row is a single
--      scheduled point for a given channel, relative to race start or the
--      registration deadline.
--
-- This file should be run AFTER notifications-schema.sql.
-- =============================================================================

-- ─── Per-group notification channel toggles ──────────────────────────────────

create table if not exists public.group_notification_settings (
  group_id uuid primary key references public.groups (id) on delete cascade,
  enable_new_marathon boolean not null default true,
  enable_result_added boolean not null default true,
  enable_race_reminders boolean not null default true,
  enable_registration_nudge boolean not null default false,
  enable_race_announcement boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists group_notification_settings_updated on public.group_notification_settings;
create trigger group_notification_settings_updated before update on public.group_notification_settings
  for each row execute function public.set_updated_at();

-- ─── Scheduled reminder points (cadence) ─────────────────────────────────────

create table if not exists public.notification_schedules (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  channel text not null check (channel in ('race_reminder', 'registration_nudge', 'race_announcement')),
  days_before integer not null default 1,
  hours_before integer not null default 9,
  frequency text not null default 'once' check (frequency in ('once', 'daily')),
  relative_to text not null default 'race_start' check (relative_to in ('race_start', 'registration_deadline')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, channel, days_before, hours_before, relative_to)
);

create index if not exists notification_schedules_group_idx on public.notification_schedules (group_id);

drop trigger if exists notification_schedules_updated on public.notification_schedules;
create trigger notification_schedules_updated before update on public.notification_schedules
  for each row execute function public.set_updated_at();

-- ─── Default rows for an existing group (call once per group) ────────────────
-- Seed sensible defaults so the admin UI has something to show.
-- Safe to re-run; it will fill in any missing group rows.

insert into public.group_notification_settings (group_id)
select g.id
from public.groups g
where not exists (select 1 from public.group_notification_settings s where s.group_id = g.id);

-- Default schedule rows (if none exist for a group):
--   race_reminder     -> 1 day before at 09:00 (once)
--   race_reminder     -> 1 hour before at 00:00 (once)  (hours_before 0 = at start window)
--   registration_nudge-> 7 days before at 09:00 (once)
--   race_announcement -> 14 days before at 09:00 (once)

insert into public.notification_schedules (group_id, channel, days_before, hours_before, frequency, relative_to)
select g.id, 'race_reminder', 1, 9, 'once', 'race_start'
from public.groups g
where not exists (
  select 1 from public.notification_schedules s
  where s.group_id = g.id and s.channel = 'race_reminder'
);

insert into public.notification_schedules (group_id, channel, days_before, hours_before, frequency, relative_to)
select g.id, 'race_reminder', 0, 0, 'once', 'race_start'
from public.groups g
where not exists (
  select 1 from public.notification_schedules s
  where s.group_id = g.id and s.channel = 'race_reminder' and s.days_before = 0
);

insert into public.notification_schedules (group_id, channel, days_before, hours_before, frequency, relative_to)
select g.id, 'registration_nudge', 7, 9, 'once', 'registration_deadline'
from public.groups g
where not exists (
  select 1 from public.notification_schedules s
  where s.group_id = g.id and s.channel = 'registration_nudge'
);

insert into public.notification_schedules (group_id, channel, days_before, hours_before, frequency, relative_to)
select g.id, 'race_announcement', 14, 9, 'once', 'race_start'
from public.groups g
where not exists (
  select 1 from public.notification_schedules s
  where s.group_id = g.id and s.channel = 'race_announcement'
);

-- ─── Auto-create settings row when a new group is created ─────────────────────

create or replace function public.ensure_group_notification_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.group_notification_settings (group_id) values (new.id)
  on conflict (group_id) do nothing;

  insert into public.notification_schedules (group_id, channel, days_before, hours_before, frequency, relative_to) values
    (new.id, 'race_reminder', 1, 9, 'once', 'race_start'),
    (new.id, 'race_reminder', 0, 0, 'once', 'race_start'),
    (new.id, 'registration_nudge', 7, 9, 'once', 'registration_deadline'),
    (new.id, 'race_announcement', 14, 9, 'once', 'race_start')
  on conflict (group_id, channel, days_before, hours_before, relative_to) do nothing;

  return new;
end;
$$;

drop trigger if exists groups_ensure_notification_settings on public.groups;
create trigger groups_ensure_notification_settings
  after insert on public.groups
  for each row execute function public.ensure_group_notification_settings();

-- ─── Schedule-driven generation function ─────────────────────────────────────
-- Replaces the single hardcoded 1-hour reminder in notifications-schema.sql.
--
-- Called by pg_cron every 5 minutes. For each enabled schedule row, it scans
-- marathons and produces a notification when the current time falls within the
-- configured "fire window" for that point.
--
-- Fire window logic per row:
--   • days_before = 0, hours_before = 0  -> fires when race starts within 60 min
--   • days_before = 0, hours_before > 0  -> fires within the hour before the
--     race start at hour `hours_before` (0 = 00:00, e.g. race at 18:00, set 0 -> 18:00)
--   • days_before > 0                    -> fires on the day X days before the
--     target date at `hours_before` o'clock, within a 60-minute window.
--
-- relative_to = 'race_start'             -> target = race_date + race_time
-- relative_to = 'registration_deadline'  -> target = registration_deadline

create or replace function public.generate_scheduled_notifications()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sched record;
  v_settings record;
  v_race record;
  v_target timestamptz;
  v_fire_start timestamptz;
  v_fire_end timestamptz;
  v_now timestamptz;
  v_type text;
  v_title text;
  v_body text;
  v_data jsonb;
  v_registered_only boolean;
begin
  v_now := now();

  -- Read settings once (assume single-group default; groups with no row get true)
  select * into v_settings
  from public.group_notification_settings
  where group_id = (select min(group_id) from public.group_notification_settings)
  limit 1;

  for v_sched in
    select s.*
    from public.notification_schedules s
    where s.enabled = true
    order by s.channel, s.days_before
  loop
    -- Determine channel type + whether it's enabled in settings
    if v_sched.channel = 'race_reminder' then
      if not coalesce(v_settings.enable_race_reminders, true) then continue; end if;
      v_type := 'race_reminder';
      v_registered_only := true;
    elsif v_sched.channel = 'registration_nudge' then
      if not coalesce(v_settings.enable_registration_nudge, false) then continue; end if;
      v_type := 'registration_nudge';
      v_registered_only := true;
    elsif v_sched.channel = 'race_announcement' then
      if not coalesce(v_settings.enable_race_announcement, false) then continue; end if;
      v_type := 'race_announcement';
      v_registered_only := false;
    end if;

    -- Iterate over applicable marathons
    for v_race in
      select
        m.id as marathon_id,
        m.group_id,
        m.name,
        m.race_date,
        m.race_time,
        m.registration_deadline,
        (m.race_date::text || ' ' || coalesce(nullif(m.race_time, ''), '09:00'))::timestamp at time zone 'utc' as start_utc
      from public.marathons m
      where m.race_date >= (current_date - 1)
        and (m.race_date::text || ' ' || coalesce(nullif(m.race_time, ''), '09:00'))::timestamp at time zone 'utc' > v_now - interval '1 day'
    loop
      -- Determine target timestamp
      if v_sched.relative_to = 'registration_deadline'
         and coalesce(v_race.registration_deadline, '') <> '' then
        v_target := (v_race.registration_deadline::text || ' ' || coalesce(nullif(v_race.race_time, ''), '09:00'))::timestamp at time zone 'utc';
      else
        v_target := v_race.start_utc;
      end if;

      if v_target is null or v_target <= v_now then continue; end if;

      -- Compute fire window
      if v_sched.days_before = 0 and v_sched.hours_before = 0 then
        -- "1 hour before" style: fire within 60 min before start
        v_fire_start := v_target - interval '60 minutes';
        v_fire_end := v_target - interval '10 minutes';
      elsif v_sched.days_before = 0 then
        -- Same-day, at a specific hour before the start (hours_before = 0 means exactly at start)
        v_fire_start := v_target - make_interval(hours => v_sched.hours_before) - interval '5 minutes';
        v_fire_end := v_target - make_interval(hours => v_sched.hours_before) + interval '55 minutes';
      else
        -- Days before, at given hour
        v_fire_start := (v_target::date - v_sched.days_before)::timestamp + make_interval(hours => v_sched.hours_before) at time zone 'utc';
        v_fire_end := v_fire_start + interval '60 minutes';
      end if;

      -- For 'daily' frequency, only fire if within this run's window (the pg_cron
      -- cadence handles subsequent days). For 'once', the dedup below prevents
      -- duplicates across runs.
      if v_now not between v_fire_start and v_fire_end then continue; end if;

      -- Build message
      if v_type = 'race_reminder' then
        v_title := 'Race reminder: ' || v_race.name;
        v_body := coalesce(nullif(v_race.race_time, ''), '09:00') || ' start · ' || v_race.name;
        v_data := jsonb_build_object('marathon_id', v_race.marathon_id, 'marathon_name', v_race.name);
      elsif v_type = 'registration_nudge' then
        v_title := 'Registration open: ' || v_race.name;
        v_body := 'Don\u2019t forget to sign up for ' || v_race.name || ' (Closes ' || to_char(v_race.race_date - 1, 'Mon DD') || ').';
        v_data := jsonb_build_object('marathon_id', v_race.marathon_id, 'marathon_name', v_race.name);
      else
        v_title := 'Upcoming race: ' || v_race.name;
        v_body := v_race.name || ' is coming up on ' || to_char(v_race.race_date, 'Mon DD, YYYY') || '.';
        v_data := jsonb_build_object('marathon_id', v_race.marathon_id, 'marathon_name', v_race.name);
      end if;

      -- Insert notification(s)
      if v_registered_only then
        insert into public.notifications (user_id, group_id, type, title, body, data)
        select distinct
          r.user_id,
          v_race.group_id,
          v_type,
          v_title,
          v_body,
          v_data
        from public.registrations reg
        join public.runners r on r.id = reg.runner_id
        where reg.marathon_id = v_race.marathon_id
          and r.user_id is not null
          and not exists (
            select 1 from public.notifications n
            where n.user_id = r.user_id
              and n.type = v_type
              and n.data->>'marathon_id' = v_race.marathon_id::text
              and n.created_at > v_now - interval '2 days'
          );
      else
        insert into public.notifications (user_id, group_id, type, title, body, data)
        select
          gm.user_id,
          v_race.group_id,
          v_type,
          v_title,
          v_body,
          v_data
        from public.group_memberships gm
        where gm.group_id = v_race.group_id
          and not exists (
            select 1 from public.notifications n
            where n.user_id = gm.user_id
              and n.type = v_type
              and n.data->>'marathon_id' = v_race.marathon_id::text
              and n.created_at > v_now - interval '2 days'
          );
      end if;
    end loop;
  end loop;
end;
$$;

-- ─── Schedule the new generator (replaces the old single-reminder job) ───────

-- Unschedold old job if present
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    if exists (select 1 from cron.job where jobname = 'pacepack-race-reminders') then
      perform cron.unschedule('pacepack-race-reminders');
    end if;
    if exists (select 1 from cron.job where jobname = 'pacepack-scheduled-notifications') then
      perform cron.unschedule('pacepack-scheduled-notifications');
    end if;
    perform cron.schedule(
      'pacepack-scheduled-notifications',
      '*/5 * * * *',
      $cron$select public.generate_scheduled_notifications()$cron$
    );
  end if;
end;
$$;

-- ─── RLS & Grants ────────────────────────────────────────────────────────────

grant select, insert, update, delete on public.group_notification_settings to authenticated;
grant select, insert, update, delete on public.notification_schedules to authenticated;

alter table public.group_notification_settings enable row level security;
alter table public.notification_schedules enable row level security;

-- Notification settings: any authenticated group member can read; admins can update
drop policy if exists group_notification_settings_select on public.group_notification_settings;
drop policy if exists group_notification_settings_insert on public.group_notification_settings;
drop policy if exists group_notification_settings_update on public.group_notification_settings;
drop policy if exists group_notification_settings_delete on public.group_notification_settings;

create policy group_notification_settings_select on public.group_notification_settings for select to authenticated
  using (exists (
    select 1 from public.group_memberships gm
    where gm.group_id = group_notification_settings.group_id and gm.user_id = auth.uid()
  ));

create policy group_notification_settings_insert on public.group_notification_settings for insert to authenticated
  with check (exists (
    select 1 from public.group_memberships gm
    where gm.group_id = group_notification_settings.group_id and gm.user_id = auth.uid()
      and gm.role in ('admin', 'moderator')
  ));

create policy group_notification_settings_update on public.group_notification_settings for update to authenticated
  using (exists (
    select 1 from public.group_memberships gm
    where gm.group_id = group_notification_settings.group_id and gm.user_id = auth.uid()
      and gm.role in ('admin', 'moderator')
  ))
  with check (exists (
    select 1 from public.group_memberships gm
    where gm.group_id = group_notification_settings.group_id and gm.user_id = auth.uid()
      and gm.role in ('admin', 'moderator')
  ));

create policy group_notification_settings_delete on public.group_notification_settings for delete to authenticated
  using (exists (
    select 1 from public.group_memberships gm
    where gm.group_id = group_notification_settings.group_id and gm.user_id = auth.uid()
      and gm.role in ('admin', 'moderator')
  ));

-- Schedules: members can read; admins can CRUD
drop policy if exists notification_schedules_select on public.notification_schedules;
drop policy if exists notification_schedules_insert on public.notification_schedules;
drop policy if exists notification_schedules_update on public.notification_schedules;
drop policy if exists notification_schedules_delete on public.notification_schedules;

create policy notification_schedules_select on public.notification_schedules for select to authenticated
  using (exists (
    select 1 from public.group_memberships gm
    where gm.group_id = notification_schedules.group_id and gm.user_id = auth.uid()
  ));

create policy notification_schedules_insert on public.notification_schedules for insert to authenticated
  with check (exists (
    select 1 from public.group_memberships gm
    where gm.group_id = notification_schedules.group_id and gm.user_id = auth.uid()
      and gm.role in ('admin', 'moderator')
  ));

create policy notification_schedules_update on public.notification_schedules for update to authenticated
  using (exists (
    select 1 from public.group_memberships gm
    where gm.group_id = notification_schedules.group_id and gm.user_id = auth.uid()
      and gm.role in ('admin', 'moderator')
  ))
  with check (exists (
    select 1 from public.group_memberships gm
    where gm.group_id = notification_schedules.group_id and gm.user_id = auth.uid()
      and gm.role in ('admin', 'moderator')
  ));

create policy notification_schedules_delete on public.notification_schedules for delete to authenticated
  using (exists (
    select 1 from public.group_memberships gm
    where gm.group_id = notification_schedules.group_id and gm.user_id = auth.uid()
      and gm.role in ('admin', 'moderator')
  ));

-- ─── Realtime (so the admin UI updates live) ─────────────────────────────────

alter table public.group_notification_settings replica identity full;
alter table public.notification_schedules replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.group_notification_settings;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.notification_schedules;
  exception when duplicate_object then null;
  end;
end $$;
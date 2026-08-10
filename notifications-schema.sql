-- =============================================================================
-- PacePack — Notifications & Web Push schema
-- Run this in Supabase → SQL Editor → New query → Run
--
-- Also required in Supabase Dashboard:
--   Project Settings → Edge Functions → create the `send-notifications` function
--   (see supabase/functions/send-notifications/index.ts)
--   Set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY secrets (generate with:
--     npx web-push generate-vapid-keys )
--   Database → Extensions → enable pg_cron
-- =============================================================================

-- Create pg_cron extension if available. This is required for scheduled race reminders.
-- If the extension is not installed on the server, this will be skipped.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'cron') then
    execute 'create extension if not exists cron';
  else
    raise notice 'pg_cron extension is not available on this server; scheduled race reminders will be skipped.';
  end if;
end;
$$;

-- ─── Notifications (in-app + push queue) ─────────────────────────────────────

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  group_id uuid not null references public.groups (id) on delete cascade,
  type text not null check (type in ('new_marathon', 'result_added', 'race_reminder')),
  title text not null,
  body text not null default '',
  data jsonb not null default '{}'::jsonb,
  is_read boolean not null default false,
  sent_push boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_user_unread_idx on public.notifications (user_id) where is_read = false;
create index if not exists notifications_group_idx on public.notifications (group_id);

-- ─── Web Push subscriptions ──────────────────────────────────────────────────

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  group_id uuid not null references public.groups (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
create index if not exists push_subscriptions_group_idx on public.push_subscriptions (group_id);

-- ─── updated_at helper reuse (already defined in top schema) ─────────────────
-- If set_updated_at doesn't exist yet (safe to re-run):
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists push_subscriptions_updated on public.push_subscriptions;
create trigger push_subscriptions_updated before update on public.push_subscriptions
  for each row execute function public.set_updated_at();

-- ─── Auto-generate notifications ─────────────────────────────────────────────

-- 1. New marathon added → notify every group member except the creator
create or replace function public.notify_new_marathon()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (user_id, group_id, type, title, body, data)
  select
    gm.user_id,
    new.group_id,
    'new_marathon',
    'New race added: ' || new.name,
    'A new ' || coalesce(new.distance, 'race') || ' is scheduled for ' ||
      to_char(new.race_date, 'Mon DD, YYYY') || ' at ' || coalesce(new.race_time, '09:00') || '.',
    jsonb_build_object('marathon_id', new.id, 'marathon_name', new.name, 'race_date', new.race_date, 'race_time', new.race_time)
  from public.group_memberships gm
  where gm.group_id = new.group_id
    and gm.user_id is distinct from new.created_by;
  return new;
end;
$$;

drop trigger if exists marathons_notify_insert on public.marathons;
create trigger marathons_notify_insert
  after insert on public.marathons
  for each row execute function public.notify_new_marathon();

-- 2. Result added for a race → notify all runners registered for that race
--    (including the runner themselves + their linked app user)
create or replace function public.notify_result_added()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_marathon public.marathons;
  v_runner public.runners;
begin
  -- Only fire when a result/time was actually added.
  if TG_OP = 'UPDATE' then
    if coalesce(new.gun_time, '') = coalesce(old.gun_time, '')
       and coalesce(new.chip_time, '') = coalesce(old.chip_time, '')
       and new.status = old.status then
      return new;
    end if;
  end if;

  if coalesce(new.gun_time, '') = '' and coalesce(new.chip_time, '') = '' and new.status not in ('completed', 'dnf') then
    return new;
  end if;

  select * into v_marathon from public.marathons where id = new.marathon_id;
  select * into v_runner from public.runners where id = new.runner_id;

  insert into public.notifications (user_id, group_id, type, title, body, data)
  select
    gm.user_id,
    new.group_id,
    'result_added',
    'Result logged: ' || coalesce(v_runner.name, 'Runner') || ' · ' || coalesce(v_marathon.name, 'Race'),
    'A finish time has been recorded for ' || coalesce(v_marathon.name, 'the race') ||
      coalesce(' (' || nullif(new.chip_time, '') || ')', '') || '.',
    jsonb_build_object(
      'marathon_id', new.marathon_id,
      'marathon_name', v_marathon.name,
      'runner_id', new.runner_id,
      'runner_name', v_runner.name,
      'registration_id', new.id,
      'chip_time', new.chip_time,
      'gun_time', new.gun_time,
      'is_pr', new.is_pr
    )
  from public.group_memberships gm
  where gm.group_id = new.group_id;
end;
$$;

drop trigger if exists registrations_result_notify on public.registrations;
create trigger registrations_result_notify
  after insert or update on public.registrations
  for each row execute function public.notify_result_added();

-- ─── Race-start reminder (1 hour before) — pg_cron ───────────────────────────
-- This runs every 10 minutes. For each upcoming race starting in ~60 minutes,
-- it inserts a notification for every runner registered for that race.
-- To enable: Supabase Dashboard → Database → Extensions → pg_cron → Enable

create or replace function public.generate_race_reminders()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_race record;
  v_target timestamptz;
begin
  for v_race in
    select
      m.id as marathon_id,
      m.group_id,
      m.name,
      m.race_date,
      m.race_time,
      (m.race_date::text || ' ' || coalesce(nullif(m.race_time, ''), '09:00'))::timestamp at time zone 'utc' as start_utc
    from public.marathons m
    where (
      m.race_date::text || ' ' || coalesce(nullif(m.race_time, ''), '09:00')
    )::timestamp at time zone 'utc'
      between now() + interval '50 minutes' and now() + interval '70 minutes'
  loop
    insert into public.notifications (user_id, group_id, type, title, body, data)
    select distinct
      r.user_id,
      v_race.group_id,
      'race_reminder',
      'Race starts in 1 hour: ' || v_race.name,
      'Get ready — ' || v_race.name || ' starts at ' || coalesce(nullif(v_race.race_time, ''), '09:00') || '. Good luck!',
      jsonb_build_object('marathon_id', v_race.marathon_id, 'marathon_name', v_race.name)
    from public.registrations reg
    join public.runners r on r.id = reg.runner_id
    where reg.marathon_id = v_race.marathon_id
      and r.user_id is not null
      and not exists (
        select 1 from public.notifications n
        where n.user_id = r.user_id
          and n.type = 'race_reminder'
          and n.data->>'marathon_id' = v_race.marathon_id::text
          and n.created_at > now() - interval '2 hours'
      );
  end loop;
end;
$$;

-- Schedule it (idempotent) only when pg_cron is installed.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    if exists (select 1 from cron.job where jobname = 'pacepack-race-reminders') then
      perform cron.unschedule('pacepack-race-reminders');
    end if;
    perform cron.schedule(
      'pacepack-race-reminders',
      '*/10 * * * *',
      $cron$select public.generate_race_reminders()$cron$
    );
  end if;
end;
$$;

-- ─── VAPID public key (for client-side push subscription) ────────────────────
-- Set this to your VAPID public key (generate with: npx web-push generate-vapid-keys)
-- Replace 'YOUR_VAPID_PUBLIC_KEY_HERE' with the actual key.

create or replace function public.get_vapid_public_key()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select 'YOUR_VAPID_PUBLIC_KEY_HERE'::text
  where exists (
    select 1 from public.group_memberships
    where user_id = auth.uid()
  );
$$;

grant execute on function public.get_vapid_public_key() to authenticated;

-- ─── Grants & RLS ────────────────────────────────────────────────────────────

grant select, insert, update, delete on public.notifications to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

alter table public.notifications enable row level security;
alter table public.push_subscriptions enable row level security;

-- Notifications: members can read their own; delete their own; insert comes from triggers
drop policy if exists notifications_select on public.notifications;
drop policy if exists notifications_update on public.notifications;
drop policy if exists notifications_delete on public.notifications;
drop policy if exists notifications_insert on public.notifications;

create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid());

create policy notifications_insert on public.notifications for insert to authenticated
  with check (user_id = auth.uid() or exists (
    select 1 from public.group_memberships gm where gm.group_id = notifications.group_id and gm.user_id = auth.uid()
  ));

create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy notifications_delete on public.notifications for delete to authenticated
  using (user_id = auth.uid());

-- Push subscriptions: own only
drop policy if exists push_subscriptions_select on public.push_subscriptions;
drop policy if exists push_subscriptions_insert on public.push_subscriptions;
drop policy if exists push_subscriptions_update on public.push_subscriptions;
drop policy if exists push_subscriptions_delete on public.push_subscriptions;

create policy push_subscriptions_select on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());

create policy push_subscriptions_insert on public.push_subscriptions for insert to authenticated
  with check (user_id = auth.uid());

create policy push_subscriptions_update on public.push_subscriptions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy push_subscriptions_delete on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

-- ─── Realtime (so the bell updates live) ─────────────────────────────────────

alter table public.notifications replica identity full;
alter table public.push_subscriptions replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.notifications;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.push_subscriptions;
  exception when duplicate_object then null;
  end;
end $$;
-- PacePack automated analytics and safe backfill
-- Run after MIGRATE-ALL.sql, notifications-schema.sql, and achievement-automation.sql.
-- Safe to run repeatedly. registrations/marathons remain the source of truth.

alter table public.runners add column if not exists join_date date;

create or replace function public.pp_time_seconds(value text)
returns integer
language plpgsql immutable strict
as $$
declare
  parts text[];
  h integer;
  m integer;
  s integer;
begin
  if btrim(value) = '' then return null; end if;
  if btrim(value) ~ '^\d+$' then return btrim(value)::integer; end if;
  parts := string_to_array(btrim(value), ':');
  if array_length(parts, 1) = 2 then
    m := parts[1]::integer; s := parts[2]::integer;
    if m < 0 or s not between 0 and 59 then return null; end if;
    return m * 60 + s;
  elsif array_length(parts, 1) = 3 then
    h := parts[1]::integer; m := parts[2]::integer; s := parts[3]::integer;
    if h < 0 or m not between 0 and 59 or s not between 0 and 59 then return null; end if;
    return h * 3600 + m * 60 + s;
  end if;
  return null;
exception when invalid_text_representation then
  return null;
end;
$$;

create or replace function public.pp_distance_label(value text)
returns text
language sql immutable
as $$
  select case
    when lower(regexp_replace(coalesce(value, ''), '[[:space:]-]', '', 'g')) in ('5k','5km') then '5K'
    when lower(regexp_replace(coalesce(value, ''), '[[:space:]-]', '', 'g')) in ('7.5k','7.5km') then '7.5K'
    when lower(regexp_replace(coalesce(value, ''), '[[:space:]-]', '', 'g')) in ('10k','10km') then '10K'
    when lower(regexp_replace(coalesce(value, ''), '[[:space:]-]', '', 'g')) in ('15k','15km') then '15K'
    when lower(regexp_replace(coalesce(value, ''), '[[:space:]-]', '', 'g')) in ('half','halfmarathon','21k','21.1k','21km','21.1km') then 'Half Marathon'
    when lower(regexp_replace(coalesce(value, ''), '[[:space:]-]', '', 'g')) in ('marathon','fullmarathon','42k','42.2k','42km','42.2km') then 'Marathon'
    when btrim(coalesce(value, '')) = '' then 'Other'
    else btrim(value)
  end;
$$;

create or replace function public.pp_distance_km(value text)
returns numeric
language sql immutable
as $$
  select case public.pp_distance_label(value)
    when '5K' then 5 when '7.5K' then 7.5 when '10K' then 10 when '15K' then 15
    when 'Half Marathon' then 21.0975 when 'Marathon' then 42.195 else null end;
$$;

create or replace function public.pp_emit_achievement_event(
  p_type text, p_group_id uuid, p_runner_id uuid, p_registration_id uuid default null, p_badge_key text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_runner_name text;
  v_race_name text;
  v_distance text;
  v_time text;
  v_content text;
  v_title text;
  v_body text;
  v_actor_id uuid;
begin
  -- Backfills deliberately do not notify members or create a flood of posts.
  if coalesce(current_setting('pacepack.analytics_backfill', true), 'off') = 'on' then return; end if;
  select name into v_runner_name from public.runners where id = p_runner_id;
  if p_type = 'pr_detected' then
    select m.name, public.pp_distance_label(m.distance), coalesce(nullif(r.chip_time,''), r.gun_time)
      into v_race_name, v_distance, v_time
    from public.registrations r join public.marathons m on m.id = r.marathon_id
    where r.id = p_registration_id;
    v_title := 'New personal record!';
    v_body := coalesce(v_runner_name, 'Runner') || ' set a ' || coalesce(v_distance, 'race') || ' PR' || coalesce(': ' || v_time, '') || '.';
    v_content := coalesce(v_runner_name, 'Runner') || ' set a new ' || coalesce(v_distance, 'race') || ' PR: ' || coalesce(v_time, 'a faster time') || '!';
  else
    v_title := 'Badge unlocked!';
    v_body := coalesce(v_runner_name, 'Runner') || ' earned the ' || replace(coalesce(p_badge_key, 'achievement'), '_', ' ') || ' badge.';
    v_content := v_body;
  end if;
  insert into public.notifications (user_id, group_id, type, title, body, data)
  select gm.user_id, p_group_id, p_type, v_title, v_body,
    jsonb_build_object('runner_id', p_runner_id, 'registration_id', p_registration_id, 'badge_key', p_badge_key)
  from public.group_memberships gm
  where gm.group_id = p_group_id
    and not exists (
      select 1 from public.notifications n
      where n.user_id = gm.user_id and n.group_id = p_group_id and n.type = p_type
        and ((p_registration_id is not null and n.data->>'registration_id' = p_registration_id::text)
          or (p_badge_key is not null and n.data->>'badge_key' = p_badge_key and n.data->>'runner_id' = p_runner_id::text))
    );
  select coalesce((select user_id from public.group_memberships where group_id=p_group_id order by created_at limit 1), auth.uid()) into v_actor_id;
  if v_actor_id is not null and to_regclass('public.community_posts') is not null then
    insert into public.community_posts (group_id, user_id, runner_id, title, content)
    select p_group_id, v_actor_id, p_runner_id, v_title, v_content
    where not exists (select 1 from public.community_posts where group_id=p_group_id and content=v_content);
  end if;
end;
$$;

create or replace function public.recalculate_runner_analytics(p_runner_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_group_id uuid;
  v_join_date date;
begin
  select group_id into v_group_id from public.runners where id = p_runner_id;
  if v_group_id is null then return; end if;

  -- Rebuild only system-owned PR rows. Unknown/manual legacy badge keys survive.
  delete from public.personal_records where runner_id = p_runner_id;
  insert into public.personal_records
    (group_id, runner_id, distance, time_seconds, pace_seconds_per_km,
     race_date, race_name, location, is_new_pr)
  select distinct on (public.pp_distance_label(m.distance))
    r.group_id, r.runner_id, public.pp_distance_label(m.distance),
    coalesce(public.pp_time_seconds(r.chip_time), public.pp_time_seconds(r.gun_time)),
    coalesce(public.pp_time_seconds(r.chip_time), public.pp_time_seconds(r.gun_time))
      / nullif(public.pp_distance_km(m.distance), 0),
    m.race_date, m.name, m.location, true
  from public.registrations r
  join public.marathons m on m.id = r.marathon_id
  where r.runner_id = p_runner_id
    and (r.status in ('completed','dnf') or public.pp_time_seconds(r.chip_time) is not null or public.pp_time_seconds(r.gun_time) is not null)
    and coalesce(public.pp_time_seconds(r.chip_time), public.pp_time_seconds(r.gun_time)) is not null
  order by public.pp_distance_label(m.distance),
    coalesce(public.pp_time_seconds(r.chip_time), public.pp_time_seconds(r.gun_time)),
    m.race_date, r.id;

  -- A result is a PR only when no earlier result at that distance was as fast.
  update public.registrations set is_pr = false
  where runner_id = p_runner_id and is_pr;
  update public.registrations r set is_pr = true
  from public.marathons m
  where r.marathon_id = m.id and r.runner_id = p_runner_id
    and (r.status in ('completed','dnf') or public.pp_time_seconds(r.chip_time) is not null or public.pp_time_seconds(r.gun_time) is not null)
    and coalesce(public.pp_time_seconds(r.chip_time), public.pp_time_seconds(r.gun_time)) is not null
    and not exists (
      select 1 from public.registrations earlier
      join public.marathons em on em.id = earlier.marathon_id
      where earlier.runner_id = r.runner_id
        and public.pp_distance_label(em.distance) = public.pp_distance_label(m.distance)
        and (earlier.status in ('completed','dnf') or public.pp_time_seconds(earlier.chip_time) is not null or public.pp_time_seconds(earlier.gun_time) is not null)
        and coalesce(public.pp_time_seconds(earlier.chip_time), public.pp_time_seconds(earlier.gun_time)) is not null
        and (em.race_date, earlier.id) < (m.race_date, r.id)
        and coalesce(public.pp_time_seconds(earlier.chip_time), public.pp_time_seconds(earlier.gun_time)) <= coalesce(public.pp_time_seconds(r.chip_time), public.pp_time_seconds(r.gun_time))
    );

  select min(m.race_date) into v_join_date
  from public.registrations r join public.marathons m on m.id = r.marathon_id
  where r.runner_id = p_runner_id;
  update public.runners set join_date = coalesce(v_join_date, join_date) where id = p_runner_id;

  -- Automated badge catalogue. Awards are permanent and ON CONFLICT makes this idempotent.
  insert into public.runner_badges (group_id, runner_id, badge_key)
  select v_group_id, p_runner_id, badge_key
  from (
    select 'first_race' badge_key where exists (select 1 from public.registrations where runner_id = p_runner_id and is_pr)
    union all select 'new_personal_record' where exists (select 1 from public.registrations where runner_id = p_runner_id and is_pr)
    union all select 'first_10k' where exists (select 1 from public.registrations r join public.marathons m on m.id=r.marathon_id where r.runner_id=p_runner_id and public.pp_distance_label(m.distance)='10K' and r.is_pr)
    union all select 'first_half_marathon' where exists (select 1 from public.registrations r join public.marathons m on m.id=r.marathon_id where r.runner_id=p_runner_id and public.pp_distance_label(m.distance)='Half Marathon' and r.is_pr)
    union all select 'first_marathon' where exists (select 1 from public.registrations r join public.marathons m on m.id=r.marathon_id where r.runner_id=p_runner_id and public.pp_distance_label(m.distance)='Marathon' and r.is_pr)
    union all select 'sub_5_marathon' where exists (select 1 from public.personal_records where runner_id=p_runner_id and distance='Marathon' and time_seconds < 18000)
    union all select 'sub_4_marathon' where exists (select 1 from public.personal_records where runner_id=p_runner_id and distance='Marathon' and time_seconds < 14400)
    union all select 'five_races' where (select count(*) from public.registrations where runner_id=p_runner_id and (status in ('completed','dnf') or public.pp_time_seconds(chip_time) is not null or public.pp_time_seconds(gun_time) is not null)) >= 5
    union all select 'ten_races' where (select count(*) from public.registrations where runner_id=p_runner_id and (status in ('completed','dnf') or public.pp_time_seconds(chip_time) is not null or public.pp_time_seconds(gun_time) is not null)) >= 10
    union all select '1000km' where (select coalesce(sum(public.pp_distance_km(m.distance)),0) from public.registrations r join public.marathons m on m.id=r.marathon_id where r.runner_id=p_runner_id and (r.status in ('completed','dnf') or public.pp_time_seconds(r.chip_time) is not null or public.pp_time_seconds(r.gun_time) is not null)) >= 1000
  ) awards
  on conflict (runner_id, badge_key) do nothing;
end;
$$;

create or replace function public.recalculate_group_analytics(p_group_id uuid default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_runner uuid; v_count integer := 0;
begin
  perform set_config('pacepack.analytics_backfill', 'on', true);
  for v_runner in select id from public.runners where p_group_id is null or group_id = p_group_id loop
    perform public.recalculate_runner_analytics(v_runner); v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.registrations_recalculate_analytics()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.recalculate_runner_analytics(old.runner_id);
    return old;
  end if;
  if tg_op = 'UPDATE' and old.runner_id is distinct from new.runner_id then
    perform public.recalculate_runner_analytics(old.runner_id);
  end if;
  perform public.recalculate_runner_analytics(new.runner_id);
  return new;
end;
$$;

drop trigger if exists registrations_recalculate_analytics on public.registrations;
create trigger registrations_recalculate_analytics
after insert or delete or update of marathon_id, runner_id, status, gun_time, chip_time
on public.registrations for each row execute function public.registrations_recalculate_analytics();

create or replace function public.registrations_pr_notification()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.is_pr and not old.is_pr then
    perform public.pp_emit_achievement_event('pr_detected', new.group_id, new.runner_id, new.id, null);
  end if;
  return new;
end;
$$;

drop trigger if exists registrations_pr_notification on public.registrations;
create trigger registrations_pr_notification
after update of is_pr on public.registrations for each row
execute function public.registrations_pr_notification();

create or replace function public.runner_badge_notification()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.pp_emit_achievement_event('badge_earned', new.group_id, new.runner_id, null, new.badge_key);
  return new;
end;
$$;

drop trigger if exists runner_badge_notification on public.runner_badges;
create trigger runner_badge_notification
after insert on public.runner_badges for each row
execute function public.runner_badge_notification();

revoke all on function public.recalculate_runner_analytics(uuid) from public, anon, authenticated;
revoke all on function public.recalculate_group_analytics(uuid) from public, anon;
grant execute on function public.recalculate_group_analytics(uuid) to authenticated;

-- One-time idempotent backfill for every current runner.
select public.recalculate_group_analytics(null);

notify pgrst, 'reload schema';

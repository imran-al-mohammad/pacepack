-- PacePack configurable race distances and per-registration distances.
-- Run after MIGRATE-ALL.sql. Safe to re-run.

create table if not exists public.group_distances (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  label text not null,
  distance_km numeric not null check (distance_km > 0),
  created_at timestamptz not null default now(),
  unique (group_id, label)
);

alter table public.registrations add column if not exists race_distance text;
create index if not exists group_distances_group_idx on public.group_distances (group_id, label);
create index if not exists registrations_race_distance_idx on public.registrations (group_id, race_distance);

insert into public.group_distances (group_id, label, distance_km)
select g.id, d.label, d.distance_km
from public.groups g
cross join (values
  ('5K', 5::numeric), ('7.5K', 7.5::numeric), ('10K', 10::numeric),
  ('15K', 15::numeric), ('Half Marathon', 21.0975::numeric), ('Marathon', 42.195::numeric)
) d(label, distance_km)
on conflict (group_id, label) do nothing;

alter table public.group_distances enable row level security;
drop policy if exists group_distances_select on public.group_distances;
drop policy if exists group_distances_manage on public.group_distances;
create policy group_distances_select on public.group_distances for select to authenticated
  using (public.is_group_member(group_id));
create policy group_distances_manage on public.group_distances for all to authenticated
  using (public.has_min_role(group_id, 'admin'))
  with check (public.has_min_role(group_id, 'admin'));

grant select, insert, update, delete on public.group_distances to authenticated;

-- Existing registrations inherit the marathon's default distance. New entries
-- are explicitly selectable by the participant.
update public.registrations r
set race_distance = m.distance
from public.marathons m
where m.id = r.marathon_id and nullif(btrim(r.race_distance), '') is null;

notify pgrst, 'reload schema';

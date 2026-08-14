-- Badge catalog + personal records / runner_badges if an older project is missing them.

create table if not exists public.personal_records (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  runner_id uuid not null references public.runners (id) on delete cascade,
  distance text not null,
  time_seconds int not null,
  pace_seconds_per_km numeric not null,
  race_date date,
  race_name text default '',
  location text default '',
  is_new_pr boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (runner_id, distance)
);

create index if not exists personal_records_group_idx on public.personal_records (group_id);
create index if not exists personal_records_runner_idx on public.personal_records (runner_id);

create table if not exists public.badges (
  key text primary key,
  label text not null,
  icon text default '🏅',
  description text default ''
);

insert into public.badges (key, label, icon, description) values
  ('first_race', 'First Race', '🏁', 'Logged a first race result'),
  ('new_personal_record', 'New Personal Record', '🏅', 'Set a personal best'),
  ('first_10k', 'First 10K', '🏃', 'Finished a 10K'),
  ('first_half_marathon', 'First Half Marathon', '🎖', 'Finished a half marathon'),
  ('first_marathon', 'First Marathon', '🎖', 'Finished a marathon'),
  ('sub_5_marathon', 'Sub-5:00 Marathon', '⚡', 'Marathon finish under 5 hours'),
  ('sub_4_marathon', 'Sub-4:00 Marathon', '⚡', 'Marathon finish under 4 hours'),
  ('five_races', '5 Races Completed', '🏁', 'Five recorded finishes'),
  ('ten_races', '10 Races Completed', '🏆', 'Ten recorded finishes'),
  ('1000km', '1000 km Club', '🏅', '1000 km of race distance')
on conflict (key) do update
  set label = excluded.label,
      icon = excluded.icon,
      description = excluded.description;

create table if not exists public.runner_badges (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  runner_id uuid not null references public.runners (id) on delete cascade,
  badge_key text not null,
  awarded_at timestamptz not null default now(),
  unique (runner_id, badge_key)
);

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'badges') then
    begin
      alter table public.runner_badges
        add constraint runner_badges_badge_key_fkey
        foreign key (badge_key) references public.badges(key);
    exception when duplicate_object then null;
    end;
  end if;
end $$;

create index if not exists runner_badges_group_idx on public.runner_badges (group_id);
create index if not exists runner_badges_runner_idx on public.runner_badges (runner_id);

alter table public.personal_records enable row level security;
alter table public.runner_badges enable row level security;
alter table public.badges enable row level security;

drop policy if exists personal_records_select on public.personal_records;
create policy personal_records_select on public.personal_records for select to authenticated
  using (public.is_group_member(group_id));

drop policy if exists runner_badges_select on public.runner_badges;
create policy runner_badges_select on public.runner_badges for select to authenticated
  using (public.is_group_member(group_id));

drop policy if exists badges_select on public.badges;
create policy badges_select on public.badges for select to authenticated using (true);

grant select on public.personal_records to authenticated;
grant select on public.runner_badges to authenticated;
grant select on public.badges to authenticated;

-- Writes stay on the service role / server backfill. Members cannot self-award.

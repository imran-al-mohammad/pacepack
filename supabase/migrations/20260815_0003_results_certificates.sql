-- Normalized results + certificates tables.
-- registrations and user_certificates remain until validation passes.

create table if not exists public.results (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  race_id uuid not null references public.marathons (id) on delete cascade,
  registration_id uuid not null references public.registrations (id) on delete cascade,
  runner_id uuid not null references public.runners (id) on delete cascade,
  status text not null default 'completed',
  gun_time text default '',
  chip_time text default '',
  place_overall text default '',
  place_gender text default '',
  place_age_group text default '',
  race_distance text default '',
  is_pr boolean not null default false,
  result_notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (registration_id)
);

create index if not exists results_group_idx on public.results (group_id);
create index if not exists results_race_idx on public.results (race_id);
create index if not exists results_runner_idx on public.results (runner_id);

create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  runner_id uuid not null references public.runners (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  race_id uuid references public.marathons (id) on delete set null,
  registration_id uuid references public.registrations (id) on delete set null,
  file_url text not null default '',
  file_name text default '',
  distance text default '',
  finish_time text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (runner_id, race_id)
);

create index if not exists certificates_group_idx on public.certificates (group_id);
create index if not exists certificates_runner_idx on public.certificates (runner_id);

alter table public.results enable row level security;
alter table public.certificates enable row level security;

drop policy if exists results_select on public.results;
create policy results_select on public.results for select to authenticated
  using (public.is_group_member(group_id));

drop policy if exists results_write on public.results;
create policy results_write on public.results for insert to authenticated
  with check (public.has_min_role(group_id, 'member'));

drop policy if exists results_update on public.results;
create policy results_update on public.results for update to authenticated
  using (public.has_min_role(group_id, 'member'));

drop policy if exists certificates_select on public.certificates;
create policy certificates_select on public.certificates for select to authenticated
  using (public.is_group_member(group_id));

drop policy if exists certificates_insert on public.certificates;
create policy certificates_insert on public.certificates for insert to authenticated
  with check (public.has_min_role(group_id, 'member'));

drop policy if exists certificates_update on public.certificates;
create policy certificates_update on public.certificates for update to authenticated
  using (
    user_id = auth.uid()
    or public.has_min_role(group_id, 'moderator')
  );

grant select, insert, update on public.results to authenticated;
grant select, insert, update on public.certificates to authenticated;

drop trigger if exists results_updated on public.results;
create trigger results_updated before update on public.results
  for each row execute function public.set_updated_at();

drop trigger if exists certificates_updated on public.certificates;
create trigger certificates_updated before update on public.certificates
  for each row execute function public.set_updated_at();

-- Seed results from already-logged registrations. Does not delete anything.
insert into public.results (
  id, group_id, race_id, registration_id, runner_id, status,
  gun_time, chip_time, place_overall, place_gender, place_age_group,
  race_distance, is_pr, result_notes
)
select
  r.id, r.group_id, r.marathon_id, r.id, r.runner_id, r.status,
  coalesce(r.gun_time, ''), coalesce(r.chip_time, ''),
  coalesce(r.place_overall, ''), coalesce(r.place_gender, ''), coalesce(r.place_age_group, ''),
  coalesce(r.race_distance, ''), r.is_pr, coalesce(r.result_notes, '')
from public.registrations r
where r.status in ('completed', 'dnf', 'dns')
   or coalesce(nullif(r.chip_time, ''), nullif(r.gun_time, '')) is not null
on conflict (registration_id) do update
  set status = excluded.status,
      gun_time = excluded.gun_time,
      chip_time = excluded.chip_time,
      place_overall = excluded.place_overall,
      place_gender = excluded.place_gender,
      is_pr = excluded.is_pr,
      race_distance = excluded.race_distance;

-- Seed certificates from the legacy user_certificates table when present.
do $$
begin
  if to_regclass('public.user_certificates') is null then
    return;
  end if;
  insert into public.certificates (
    group_id, runner_id, user_id, race_id, file_url, file_name, distance, finish_time
  )
  select
    uc.group_id,
    uc.runner_id,
    uc.user_id,
    uc.marathon_id,
    coalesce(uc.certificate_url, uc.url, ''),
    coalesce(uc.title, uc.marathon_name, 'Certificate'),
    coalesce(uc.distance, ''),
    coalesce(uc.finish_time, '')
  from public.user_certificates uc
  where not exists (
    select 1 from public.certificates c
    where c.runner_id = uc.runner_id and c.race_id = uc.marathon_id
  );
exception
  when undefined_column then
    insert into public.certificates (group_id, runner_id, race_id, file_url)
    select uc.group_id, uc.runner_id, uc.marathon_id, coalesce(uc.url, '')
    from public.user_certificates uc
    where not exists (
      select 1 from public.certificates c
      where c.runner_id = uc.runner_id and c.race_id = uc.marathon_id
    );
end $$;

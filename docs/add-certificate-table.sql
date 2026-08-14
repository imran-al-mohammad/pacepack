-- ─── User Certificates ────────────────────────────────────────────────────────
-- Stores certificates attached by users to their past race results

create table if not exists public.user_certificates (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  marathon_id uuid not null references public.marathons (id) on delete cascade,
  runner_id uuid not null references public.runners (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text default '',
  url text default '',
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (runner_id, marathon_id)
);

create index if not exists user_certificates_group_idx on public.user_certificates (group_id);
create index if not exists user_certificates_marathon_idx on public.user_certificates (marathon_id);
create index if not exists user_certificates_runner_idx on public.user_certificates (runner_id);
create index if not exists user_certificates_user_idx on public.user_certificates (user_id);

-- ─── updated_at trigger ──────────────────────────────────────────────────────

drop trigger if exists user_certificates_updated on public.user_certificates;
create trigger user_certificates_updated before update on public.user_certificates
  for each row execute function public.set_updated_at();

-- ─── RLS ───────────────────────────────────────────────────────────────────────

alter table public.user_certificates enable row level security;

-- Users can read their own certificates
drop policy if exists user_certificates_select on public.user_certificates;
create policy user_certificates_select on public.user_certificates for select to authenticated
  using (user_id = auth.uid());

-- Users can insert their own certificates (for races they're registered for)
drop policy if exists user_certificates_insert on public.user_certificates;
create policy user_certificates_insert on public.user_certificates for insert to authenticated
  with check (user_id = auth.uid());

-- Users can update their own certificates
drop policy if exists user_certificates_update on public.user_certificates;
create policy user_certificates_update on public.user_certificates for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Users can delete their own certificates
drop policy if exists user_certificates_delete on public.user_certificates;
create policy user_certificates_delete on public.user_certificates for delete to authenticated
  using (user_id = auth.uid());

-- ─── Realtime ──────────────────────────────────────────────────────────────────

alter table public.user_certificates replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.user_certificates;
  exception when duplicate_object then null;
  end;
end $$;
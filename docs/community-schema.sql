-- =============================================================================
-- PacePack — Community Board schema
-- Run this in Supabase → SQL Editor → New query → Run
--
-- Adds a self-referencing posts table so group members can start topics and
-- reply to each other. Top-level posts (parent_id IS NULL) are topics;
-- replies have parent_id pointing at the post they answer.
-- =============================================================================

create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  runner_id uuid references public.runners (id) on delete set null,
  title text,
  content text not null,
  is_pinned boolean not null default false,
  parent_id uuid references public.community_posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.community_posts add column if not exists is_pinned boolean not null default false;

create index if not exists community_posts_group_idx on public.community_posts (group_id);
create index if not exists community_posts_parent_idx on public.community_posts (parent_id);
create index if not exists community_posts_user_idx on public.community_posts (user_id);
create index if not exists community_posts_created_idx on public.community_posts (group_id, created_at desc);
create index if not exists community_posts_pinned_idx on public.community_posts (group_id, is_pinned, created_at desc);

-- updated_at trigger (reuses the shared set_updated_at helper)
drop trigger if exists community_posts_updated on public.community_posts;
create trigger community_posts_updated before update on public.community_posts
  for each row execute function public.set_updated_at();

-- ─── Row Level Security ────────────────────────────────────────────────────────

alter table public.community_posts enable row level security;

-- Members can read all posts in their group
drop policy if exists community_posts_select on public.community_posts;
create policy community_posts_select on public.community_posts for select to authenticated
  using (public.is_group_member(group_id));

-- Members can create posts (topics or replies)
drop policy if exists community_posts_insert on public.community_posts;
create policy community_posts_insert on public.community_posts for insert to authenticated
  with check (public.has_min_role(group_id, 'member'));

-- Authors can edit their own posts; moderators+ can edit any
drop policy if exists community_posts_update on public.community_posts;
create policy community_posts_update on public.community_posts for update to authenticated
  using (user_id = auth.uid() or public.has_min_role(group_id, 'moderator'))
  with check (public.has_min_role(group_id, 'member'));

-- Authors can delete their own posts; moderators+ can delete any
drop policy if exists community_posts_delete on public.community_posts;
create policy community_posts_delete on public.community_posts for delete to authenticated
  using (user_id = auth.uid() or public.has_min_role(group_id, 'moderator'));

-- ─── Grants ───────────────────────────────────────────────────────────────────

grant select, insert, update, delete on public.community_posts to authenticated;

-- ─── Realtime ─────────────────────────────────────────────────────────────────

alter table public.community_posts replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.community_posts;
  exception when duplicate_object then null;
  end;
end $$;

-- ─── Reload schema cache ──────────────────────────────────────────────────────

notify pgrst, 'reload schema';

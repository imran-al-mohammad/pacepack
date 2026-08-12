-- Community access-control update. Run after community-schema.sql.
alter table public.community_posts add column if not exists post_type text not null default 'board';

drop policy if exists community_posts_insert on public.community_posts;
create policy community_posts_insert on public.community_posts for insert to authenticated
  with check (
    public.has_min_role(group_id, 'member')
    and (parent_id is not null or coalesce(post_type, 'board') = 'board')
  );

drop policy if exists community_posts_update on public.community_posts;
create policy community_posts_update on public.community_posts for update to authenticated
  using (
    (coalesce(post_type, 'board') = 'announcement' and public.has_min_role(group_id, 'admin'))
    or (coalesce(post_type, 'board') <> 'announcement' and (user_id = auth.uid() or public.has_min_role(group_id, 'moderator')))
  )
  with check (
    (coalesce(post_type, 'board') = 'announcement' and public.has_min_role(group_id, 'admin'))
    or (coalesce(post_type, 'board') <> 'announcement' and public.has_min_role(group_id, 'member'))
  );

drop policy if exists community_posts_delete on public.community_posts;
create policy community_posts_delete on public.community_posts for delete to authenticated
  using (
    (coalesce(post_type, 'board') = 'announcement' and public.has_min_role(group_id, 'admin'))
    or (coalesce(post_type, 'board') <> 'announcement' and (user_id = auth.uid() or public.has_min_role(group_id, 'moderator')))
  );

notify pgrst, 'reload schema';

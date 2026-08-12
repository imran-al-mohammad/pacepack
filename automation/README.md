# PacePack automation

These scripts are intentionally dependency-free and can run from cron, GitHub
Actions, or a local admin machine. They do not run a web server.

## Achievement sync

For the primary Supabase path, apply `docs/automated-analytics.sql`. Its
database trigger recalculates PRs, historical `is_pr` flags, badges, and join
dates whenever a result changes, and its final statement performs the initial
all-runner backfill. The script below remains useful for protected scheduled
notification/community announcements and snapshot dry-runs.

The job reads runners, races, registrations, existing PRs/badges, memberships,
posts, and notifications. It then detects faster finishes, upserts PRs, awards
eligible badges, and creates short posts/notifications. Re-running it is safe:
existing PRs, badges, posts, and notification event keys are skipped.

```bash
python automation/sync_achievements.py --input snapshot.json --dry-run
SUPABASE_URL="https://project.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="..." \
python automation/sync_achievements.py --group-id "GROUP_UUID"
```

Keep the service-role key in the scheduler's secret store; never put it in the
PWA or commit it to the repository. Apply `docs/achievement-automation.sql`
once so the notification type constraint accepts achievement events.

## Validation

```bash
python automation/validate_data.py snapshot.json
```

The snapshot format is the same object shape used by the frontend: arrays named
`runners`, `marathons`, `registrations`, and the achievement-related tables.

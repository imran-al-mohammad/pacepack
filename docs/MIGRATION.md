# Migration notes

This cutover is additive. Legacy rows stay until the new path has been
validated against a full group.

## 1. Apply SQL

In Supabase → SQL Editor, run in order (or `supabase db push`):

1. Existing club schema if this is a new project (`docs/MIGRATE-ALL.sql`)
2. `supabase/migrations/20260815_0001_normalize_compat.sql`
3. `supabase/migrations/20260815_0002_achievements.sql`
4. `supabase/migrations/20260815_0003_results_certificates.sql`

These scripts create views/tables and seed `results` / `certificates` from
`registrations` and `user_certificates`. They do not drop anything.

## 2. Storage

Create a `certificates` bucket if it does not exist. Certificate uploads are
files (JPG/PNG/WebP/PDF), never a pasted URL.

## 3. Dry-run the backfill

```bash
python -m app.jobs.validate --group-id GROUP_UUID
python -m app.jobs.backfill --group-id GROUP_UUID --dry-run
```

The dry-run prints how many PRs, badges, and join dates would change. Re-run
is safe: unique keys skip existing awards.

## 4. Apply the backfill

```bash
python -m app.jobs.backfill --group-id GROUP_UUID --apply
```

Omit `--announce` on the first historical pass so the community board is not
flooded. After the new app is live, result saves announce incrementally.

## 5. Validate profile tabs

Sign in to the FastAPI app and open Profile:

- Records must list PRs from historical results
- Badges must list awards from historical results
- Race History must list the runner's registrations
- Join date must equal the first race date

If those four match the legacy data, the backfill is good.

## 6. Deprecate, then delete

Only after the new app has been stable in production:

1. Stop serving `index.html` / `src/js/app.js`
2. Keep `marathons` and `registrations` until a later cutover if you want to
   rename them physically to `races` / `results`
3. Drop `user_certificates` only after `certificates` has been checked

See [DEPRECATIONS.md](DEPRECATIONS.md).

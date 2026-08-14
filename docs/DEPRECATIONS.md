# Deprecations

The FastAPI app is the supported product path. The static SPA remains in the
repo so rollback is possible.

## Deprecated now (still on disk)

| Path | Why it stays | Replacement |
| --- | --- | --- |
| `index.html` | Legacy app shell | `app/templates/` |
| `src/js/app.js` | Client-side business logic | `app/services/` + `app/views/` |
| `src/js/features/` | Client leaderboard | `analytics_service` + `/leaderboard` |
| `src/js/analytics/insights.js` | Generated browser analytics | `app/services/analytics_service.py` |
| `config.js` | Browser Supabase keys | `.env` / `app/config.py` |
| `sw.js`, `manifest.webmanifest` at repo root | Old PWA scope | `app/static/sw.js`, `app/static/manifest.webmanifest` |
| Manual PR forms in the SPA | PRs are system-detected | Profile → Records (read-only) |
| Certificate URL fields | Uploads must be files | Results/Profile certificate tab |

## Still used

| Path | Role |
| --- | --- |
| `src/css/styles.css` | Copied into `app/static/css/styles.css` |
| `public/icons/` | Copied into `app/static/icons/` |
| `automation/` | Older job scripts; prefer `app/jobs/` |
| `scrapers/` | HTML scrapers; wrapped by `app/jobs/scrape.py` |
| `docs/*.sql` | Historical schema. New changes go in `supabase/migrations/` |

## Do not delete yet

- `marathons`
- `registrations`
- `user_certificates`
- `personal_records` / `runner_badges` rows

The new `races` view and `results` / `certificates` tables are complementary.
Remove legacy objects only after the validation checklist in MIGRATION.md
passes and the FastAPI app has been the only writer for a full race cycle.

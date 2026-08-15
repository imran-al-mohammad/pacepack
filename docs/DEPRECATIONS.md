# Removed and leftover names

The static SPA has been deleted from the repo. The FastAPI app in `app/` is
the only product path.

## Removed from the repo

- `index.html`, `src/`, `config.js`
- Root PWA files (`sw.js`, `manifest.webmanifest`, `offline.html`)
- Duplicate icons in `public/`
- Browser analytics export (`analytics/`)
- Old Python jobs (`automation/`) — use `python -m app.jobs.*`
- Scratch JS (`debug.js`, `fix.js`, `temp.js`, `temp.txt`)
- SPA setup notes (`docs/ONLINE-SETUP.md`, `docs/CODE-REVIEW-FIXES.md`)

## Still used

| Path | Role |
| --- | --- |
| `app/` | Web app, services, templates, static assets |
| `scrapers/` | HTML scrapers; `python -m app.jobs.scrape` |
| `supabase/` | Edge functions + new migrations |
| `docs/*.sql` | Historical schema already applied to the club DB |
| `pacepack-design.md` | Design tokens |

## Do not drop in Supabase yet

- `marathons` — `races` is a view over this table
- `registrations` — still the write path for results
- `user_certificates` — keep until `certificates` has been the only writer
- `personal_records` / `runner_badges` rows

The `results` and `certificates` tables are complementary. Drop or rename
legacy tables only after a later dedicated schema cutover.

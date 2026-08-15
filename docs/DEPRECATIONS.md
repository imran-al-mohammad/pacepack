# Removed and leftover names

GitHub Pages serves the static SPA from `index.html`. Incremental SQL that
had already been applied to the club database was deleted from `docs/`.

## Removed from the repo

- One-shot SQL patches (`add-*.sql`, `MIGRATE-ALL.sql`, feature schema copies)
- Demo cache helpers (`src/js/dev/cache-examples.js`)
- Empty `icons/` folder

## Still used

| Path | Role |
| --- | --- |
| `index.html`, `src/` | Live GitHub Pages app |
| `app/` | Optional FastAPI local server + jobs |
| `scrapers/` | HTML scrapers |
| `supabase/` | Edge functions + FastAPI-era migrations |
| `docs/supabase-schema.sql` | Greenfield schema only |
| `docs/certificate-upload-rls.sql` | Certificates bucket policies |
| `docs/image-upload-rls.sql` | Images bucket policies |

## Do not drop in Supabase

- `marathons` — live race table
- `registrations` — live registration and result write path
- `user_certificates` — live certificate records
- `personal_records` / `runner_badges` rows

The complementary `races` view and `results` / `certificates` tables, if
present, are unused by the Pages app. Leave them until a dedicated cutover.

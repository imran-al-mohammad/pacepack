# PacePack architecture

PacePack is now a Python-centered web app. FastAPI renders pages, Jinja
templates produce the UI, HTMX swaps tabs and forms, and Supabase remains
auth, Postgres, and storage.

The previous static SPA (`index.html` + `src/js/app.js`) is deprecated but
not deleted. See [DEPRECATIONS.md](DEPRECATIONS.md).

## Stack

| Layer | Choice |
| --- | --- |
| HTTP | FastAPI |
| HTML | Jinja2 templates |
| Partial updates | HTMX |
| Database | Supabase Postgres |
| Auth | Supabase Auth (email/password), httpOnly cookies |
| Files | Supabase Storage (`certificates` bucket) |
| Jobs | `app/jobs` (PRs, badges, join dates, validation) |

JavaScript is limited to HTMX, the service worker, the next-race countdown,
and the certificate filename helper. Business rules do not live in the browser.

## Layout

```
app/
  main.py              # FastAPI factory
  config.py            # env settings
  db.py                # Supabase REST/Auth/Storage client
  deps.py              # session + group context
  templating.py        # Jinja + nav
  views/               # server-rendered pages + HTMX endpoints
  services/            # business logic
  templates/           # pages and partials
  static/              # CSS, tiny JS, PWA assets
  jobs/                # backfills, validation, scraper wrapper
supabase/migrations/   # additive schema, no legacy deletes
docs/                  # architecture, env, migration, deprecations
```

## Request path

1. Browser hits `/`, `/results`, `/profile`, …
2. `deps.get_context` reads the access cookie, refreshes if needed, loads
   profile, membership, group, and linked runner.
3. The view loads group-scoped rows through the user JWT so RLS still applies.
4. Services compute PRs, badges, analytics, and certificate eligibility.
5. Jinja renders a full page, or an HTMX partial for a tab/form.

## Services

| Service | Rule |
| --- | --- |
| `result_service` | Results are logged on `registrations`. Completing a result triggers side effects. |
| `pr_service` | First timed finish is a PR. Later finishes are PRs only when strictly faster. No manual entry. |
| `badge_service` | Badges are derived from results. Re-runs are idempotent. |
| `join_date_service` | Club join date = earliest race date for that runner. |
| `certificate_service` | File upload only, and only if a result is already logged. |
| `community_service` | Auto-posts for PR / badge / result events, keyed so they are not duplicated. |
| `analytics_service` | Dashboard metrics, compact insights, profile charts. |
| `storage_service` | Uploads bytes to the `certificates` bucket. Never accepts a URL as the source. |

## Data names

The live club database still uses `marathons` and `registrations`. New code
talks to those tables so production keeps working.

Compatibility objects added by migration:

- `races` — view over `marathons`
- `results` — complementary table seeded from logged registrations
- `certificates` — complementary table seeded from `user_certificates`
- `badges` — catalog
- `personal_records`, `runner_badges`, `community_posts` — already existed

Do not drop legacy tables until [MIGRATION.md](MIGRATION.md) validation passes.

## Auth

Sign-in posts email/password to FastAPI. FastAPI calls Supabase Auth and stores
`access_token` / `refresh_token` in httpOnly cookies. Page queries use the
user JWT. Jobs use `SUPABASE_SERVICE_ROLE_KEY` and never run in the browser.

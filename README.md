# PacePack

Club race tracker. **V1.3 is the main branch** and GitHub Pages serves the
static app from `index.html` (Supabase for auth, Postgres, and storage).

Certificates is its own sidebar page. Upload requires a logged result.

A FastAPI + HTMX app also lives in `app/` for local use. See
`docs/ARCHITECTURE.md` and `docs/ENV.md`.

## Run the web app

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
python -m app
```

Open http://127.0.0.1:8000 and sign in with a Supabase club account.

## Pages

Dashboard, Leaderboard, Marathons, Results & Times, Certificates, Runners,
Profile, Community, Notifications, Admin.

Profile tabs: Overview, Analytics, Records, Badges, Race History,
Certificates, Settings.

Certificates are file uploads and require a logged result. Personal records,
badges, and join dates are computed from results — they are not typed in.

## Backfill historical data

```bash
python -m app.jobs.validate --group-id GROUP_UUID
python -m app.jobs.backfill --group-id GROUP_UUID --dry-run
python -m app.jobs.backfill --group-id GROUP_UUID --apply
```

## Tests

```bash
python -m unittest discover -s tests -v
```

## Docs

- `docs/ARCHITECTURE.md`
- `docs/ENV.md`
- `docs/MIGRATION.md`
- `docs/DEPRECATIONS.md`

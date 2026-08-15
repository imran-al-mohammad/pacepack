# PacePack

Club race tracker. FastAPI renders the pages, Jinja supplies the UI, HTMX
handles tabs and forms, and Supabase remains auth, Postgres, and storage.

See `docs/ARCHITECTURE.md` for the layout and `docs/ENV.md` for keys.

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

Dashboard, Leaderboard, Marathons, Results & Times, Runners, Profile,
Community, Notifications, Admin.

Profile tabs: Overview, Analytics, Records, Badges, Race History,
Certificates, Settings.

Results tabs: Results, Certificates.

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

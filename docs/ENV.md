# Environment variables

Copy `.env.example` to `.env` in the repo root.

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Project URL from Supabase → Settings → API |
| `SUPABASE_ANON_KEY` | yes | Anon / publishable key. Used by the web app with the user JWT. |
| `SUPABASE_SERVICE_ROLE_KEY` | jobs only | Service role key. Backfills and privileged writes. Never ship this to the browser. |
| `SECRET_KEY` | yes in production | Reserved for signed flash/session helpers. |
| `APP_ENV` | no | `development` or `production` |
| `APP_HOST` / `APP_PORT` | no | Uvicorn bind defaults (`127.0.0.1:8000`) |
| `CERTIFICATES_BUCKET` | no | Defaults to `certificates` |
| `SESSION_COOKIE_SECURE` | production | Set `true` behind HTTPS |

Also required in the Supabase dashboard:

1. Authentication → Providers → Email enabled.
2. Storage bucket `certificates` (public read or signed URLs).
3. SQL migrations in `supabase/migrations/` applied in order.

The old `config.js` keys are **not** used by the FastAPI app. Leave that file
in place only for the deprecated static frontend.

# PacePack docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — FastAPI + HTMX + Supabase layout
- [ENV.md](ENV.md) — required environment variables
- [MIGRATION.md](MIGRATION.md) — what is live and what not to drop
- [DEPRECATIONS.md](DEPRECATIONS.md) — leftover database names

## SQL still in this folder

| File | When to run |
| --- | --- |
| [supabase-schema.sql](supabase-schema.sql) | New Supabase project only |
| [certificate-upload-rls.sql](certificate-upload-rls.sql) | Certificate uploads return 403 |
| [image-upload-rls.sql](image-upload-rls.sql) | Runner / race photo uploads return 403 |

One-shot club patches (certificates table, distances, notifications, etc.)
were already applied and have been removed from the repo. Do not drop
`marathons`, `registrations`, or `user_certificates`.

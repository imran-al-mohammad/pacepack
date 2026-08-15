# Migration notes

The club database is already on the live schema. Incremental SQL files were
removed from the repo. **Do not re-run old patches** and **do not drop**
legacy tables.

## New project only

1. Run `docs/supabase-schema.sql` in the Supabase SQL editor
2. Run `docs/certificate-upload-rls.sql` and `docs/image-upload-rls.sql`
3. Put the project URL and anon key in `config.js`

## Existing club project

No further SQL is required if:

- Certificates upload after a logged result
- Runner and race photos upload
- Configured distances appear in Team & Access
- Branding / group logo loads

If a storage upload returns 403, re-run only the matching RLS file above.

## Optional image copy

```bash
python -m app.jobs.migrate_images --group-id GROUP_UUID --dry-run
python -m app.jobs.migrate_images --group-id GROUP_UUID --apply
```

## Do not drop

- `marathons`
- `registrations`
- `user_certificates`

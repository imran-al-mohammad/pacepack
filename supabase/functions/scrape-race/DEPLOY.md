# Deploy `scrape-race` (replace Hello World stub)

## Common log errors

| Log / response | Cause |
|----------------|--------|
| `SyntaxError: Unexpected end of JSON input` at `req.json()` | Empty body (OPTIONS, health check, or bad client). Hello World calls `req.json()` with no guard. |
| `{"message":"Hello undefined!"}` | Still the Hello World template; it reads `name`, app sends `url`. |
| Stack has `@supabase/server` / `with-supabase.ts` | Dashboard scaffold, **not** PacePack scraper. |

Fix: deploy the full `index.ts` from this folder (safe body parsing + scrape logic).

## Dashboard (easiest)

1. Open: https://supabase.com/dashboard/project/pzpsjifvlrpmxojyfkyh/functions
2. Click **scrape-race**
3. Open the code editor / “Download & edit” / redeploy flow
4. **Delete** the Hello World body and paste the full contents of `index.ts`
5. Deploy / Save

The real function returns JSON like:

```json
{ "success": true, "data": { "name": "...", "date": "...", ... } }
```

Not:

```json
{ "message": "Hello undefined!" }
```

## CLI

```powershell
# Login once (browser)
supabase login

cd path\to\pacepack
supabase functions deploy scrape-race --project-ref pzpsjifvlrpmxojyfkyh
```

## Quick test after deploy

```powershell
Invoke-RestMethod `
  -Uri "https://pzpsjifvlrpmxojyfkyh.supabase.co/functions/v1/scrape-race" `
  -Method POST `
  -Headers @{
    "Content-Type" = "application/json"
    "Authorization" = "Bearer YOUR_ANON_KEY"
    "apikey" = "YOUR_ANON_KEY"
  } `
  -Body '{"url":"https://example.com"}'
```

You should see `"success": true` and a `data` object (fields may be mostly null for example.com).

# Deploy the results scraper

From the PacePack project root:

```bash
supabase functions deploy scrape-results
```

The Results screen's **Import results** button uses this function. After
deployment, it fetches the public results URL, returns result rows, and leaves
all database writes to the browser's explicit confirmation step.

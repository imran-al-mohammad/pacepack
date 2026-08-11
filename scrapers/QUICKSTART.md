# 🚀 Quick Start Guide

Get up and running with the Race Scraper in 5 minutes!

## Step 1: Install Dependencies (30 seconds)

```bash
cd scrapers
pip install -r requirements.txt
```

## Step 2: Test the Scraper (1 minute)

```bash
# Run the test suite to verify everything works
python test_scraper.py
```

You should see: `[SUCCESS] All tests passed!`

## Step 3: Scrape Your First Race (1 minute)

```bash
# Scrape a race page
python race_scraper.py https://example.com/race-signup
```

This will:
- Extract all available race data
- Display it in the console
- Save it to `race_data.json`

## Step 4: Use in Your Code (2 minutes)

```python
from race_scraper import scrape_race

# Scrape a race
data = scrape_race("https://example.com/race-signup")

# Access the data
print(f"Race: {data['name']}")
print(f"Date: {data['date']}")
print(f"Location: {data['location']}")
print(f"Distances: {data['distances']}")
```

## Step 5: Insert to Supabase (Optional, 1 minute)

```bash
# Setup environment variables
copy .env.example .env
# Edit .env with your Supabase credentials
```

```python
from race_scraper import scrape_race
from example_usage import get_supabase_client, insert_race_to_supabase

# Scrape
race_data = scrape_race("https://example.com/race")

# Connect to Supabase
supabase = get_supabase_client()
group_id = "your-group-uuid"

# Insert
insert_race_to_supabase(supabase, race_data, group_id)
```

## Common Use Cases

### Scrape Multiple Races

```python
from race_scraper import scrape_race
import json

urls = [
    "https://example.com/race1",
    "https://example.com/race2",
    "https://example.com/race3",
]

results = []
for url in urls:
    try:
        data = scrape_race(url)
        results.append(data)
        print(f"✓ {data['name']}")
    except Exception as e:
        print(f"✗ {url}: {e}")

# Save all results
with open("all_races.json", "w") as f:
    json.dump(results, f, indent=2)
```

### Custom Scraper Configuration

```python
from race_scraper import RaceScraper

# Create scraper with custom timeout
scraper = RaceScraper(timeout=15)

# Scrape race
data = scraper.scrape_race("https://example.com/race")
```

## What Gets Extracted?

| Field | Example | Notes |
|-------|---------|-------|
| `name` | "Dhaka Marathon 2026" | From title/OG tags |
| `date` | "2026-12-15" | ISO format |
| `start_time` | "06:00" | 24-hour format |
| `location` | "Dhaka, Bangladesh" | City/Venue |
| `distances` | ["Marathon", "Half Marathon"] | List of distances |
| `registration_url` | "https://..." | The URL you provided |
| `registration_deadline` | "2026-11-30" | ISO format |
| `organizer` | "Bangladesh Athletics Federation" | If available |
| `description` | "Short description..." | First paragraph or meta |
| `entry_fee` | "BDT 2500" | If available |
| `source_url` | "https://..." | Original URL |

**Note**: Not all fields may be available for every page. Missing fields return `None`.

## Troubleshooting

### No Data Extracted?

- Check if the page is JavaScript-heavy (scraper will auto-detect)
- Try using Playwright directly: `scraper._fetch_dynamic(url)`
- Inspect the page source to see if data is in HTML or loaded via JS

### Playwright Not Working?

```bash
pip install playwright
playwright install chromium
```

### Supabase Connection Issues?

- Verify `SUPABASE_URL` and `SUPABASE_KEY` in `.env`
- Check that the `marathons` table exists
- Ensure your API key has insert permissions

## Next Steps

- Read the full [README.md](README.md) for advanced usage
- Check [example_usage.py](example_usage.py) for Supabase integration examples
- Customize the scraper for specific race websites by editing `race_scraper.py`

## Need Help?

- Check the [README.md](README.md) for detailed documentation
- Review the test file to understand how extraction works
- Inspect page source to understand data structure

Happy scraping! 🏃‍♂️
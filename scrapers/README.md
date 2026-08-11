# 🏃 Race Scraper for PacePack

A Python-based web scraper that extracts marathon and race event data from registration/signup pages and prepares it for insertion into your PacePack Supabase database.

## Features

- ✅ **Automatic Detection**: Detects JavaScript-heavy pages and switches to Playwright automatically
- ✅ **Smart Extraction**: Extracts race name, date, time, location, distances, fees, and more
- ✅ **Data Normalization**: Converts various date/time formats to standard ISO formats
- ✅ **Error Handling**: Graceful handling of missing fields and invalid URLs
- ✅ **Supabase Ready**: Includes complete example for inserting data into your `marathons` table
- ✅ **CLI & Library**: Use as command-line tool or import as Python module

## Quick Start

### 1. Installation

```bash
# Navigate to the scrapers directory
cd scrapers

# Install dependencies
pip install -r requirements.txt

# Optional: Install Playwright for JavaScript-heavy pages
playwright install chromium
```

### 2. Basic Usage

#### Command Line

```bash
# Scrape a race page
python race_scraper.py https://example.com/marathon-signup

# Output is saved to race_data.json
```

#### As Python Module

```python
from race_scraper import scrape_race

# Scrape a race
data = scrape_race("https://example.com/marathon-signup")

print(data['name'])        # "Dhaka Marathon 2026"
print(data['date'])        # "2026-12-15"
print(data['location'])    # "Dhaka, Bangladesh"
print(data['distances'])   # ["Marathon", "Half Marathon", "10K"]
```

### 3. With Supabase Integration

```bash
# Setup environment variables
cp .env.example .env
# Edit .env with your Supabase credentials

# Run with Supabase
python example_usage.py https://example.com/marathon-signup
```

## Data Extracted

The scraper attempts to extract the following fields:

| Field | Description | Example |
|-------|-------------|---------|
| `name` | Race/Event name | "Dhaka Marathon 2026" |
| `date` | Race date (ISO format) | "2026-12-15" |
| `start_time` | Start time (24hr format) | "06:00" |
| `location` | City/Venue | "Dhaka, Bangladesh" |
| `distances` | List of distances offered | ["Marathon", "Half Marathon"] |
| `registration_url` | Signup page URL | "https://..." |
| `registration_deadline` | Registration closes (ISO) | "2026-11-30" |
| `organizer` | Event organizer | "Bangladesh Athletics Federation" |
| `description` | Short description | "Annual marathon..." |
| `entry_fee` | Registration fee | "BDT 2500" |
| `source_url` | Original URL scraped | "https://..." |

**Note**: Not all fields may be available for every page. Missing fields return `None` (null in JSON).

## Output Format

### Python Dictionary

```python
{
    "name": "Dhaka Marathon 2026",
    "date": "2026-12-15",
    "start_time": "06:00",
    "location": "Dhaka, Bangladesh",
    "distances": ["42.195 km", "21.0975 km", "10 km"],
    "registration_url": "https://example.com/signup",
    "registration_deadline": "2026-11-30",
    "organizer": "Bangladesh Athletics Federation",
    "description": "Short description...",
    "entry_fee": "BDT 2500",
    "source_url": "https://example.com/signup"
}
```

### JSON Output

```json
{
  "name": "Dhaka Marathon 2026",
  "date": "2026-12-15",
  "start_time": "06:00",
  "location": "Dhaka, Bangladesh",
  "distances": ["42.195 km", "21.0975 km", "10 km"],
  "registration_url": "https://example.com/signup",
  "registration_deadline": "2026-11-30",
  "organizer": "Bangladesh Athletics Federation",
  "description": "Short description...",
  "entry_fee": "BDT 2500",
  "source_url": "https://example.com/signup"
}
```

## Supabase Integration

### Database Schema

The scraper is designed to work with the `marathons` table in your PacePack Supabase database:

```sql
create table public.marathons (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  name text not null,
  race_date date not null,
  race_time text default '09:00',
  location text default '',
  image_url text default '',
  distance text default 'Marathon',
  notes text default '',
  reg_open_date date default null,
  reg_close_date date default null,
  reg_link text default '',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### Inserting Data

The `example_usage.py` script handles:

1. **Scraping** the race data
2. **Transforming** it to match the database schema
3. **Checking** for duplicates
4. **Inserting** or **updating** the record

```python
from example_usage import insert_race_to_supabase, transform_to_marathons_table

# Scrape race
race_data = scrape_race("https://example.com/race")

# Transform to database format
db_record = transform_to_marathons_table(race_data, group_id="your-group-uuid")

# Insert to Supabase
result = insert_race_to_supabase(supabase_client, race_data, group_id)
```

## Advanced Usage

### Batch Processing

```python
from race_scraper import scrape_race
from example_usage import scrape_multiple_races, get_supabase_client

# List of race URLs
urls = [
    "https://example.com/race1",
    "https://example.com/race2",
    "https://example.com/race3",
]

# Get Supabase client
supabase = get_supabase_client()
group_id = "your-group-uuid"

# Scrape and insert all
results = scrape_multiple_races(urls, group_id, supabase)
```

### Custom Scraper Configuration

```python
from race_scraper import RaceScraper

# Create scraper with custom timeout
scraper = RaceScraper(timeout=15)

# Scrape race
data = scraper.scrape_race("https://example.com/race")
```

### Using Playwright Directly

```python
from race_scraper import RaceScraper

scraper = RaceScraper()

# Force Playwright for JavaScript-heavy pages
soup = scraper._fetch_dynamic("https://example.com/spa-race-page")

# Then extract data manually
name = scraper._extract_name(soup)
date = scraper._extract_date(soup)
# ... etc
```

## How It Works

### 1. Page Fetching

The scraper uses a two-stage approach:

1. **Static Fetch**: First tries `requests` + `BeautifulSoup` (fast)
2. **Dynamic Detection**: Checks if page is JavaScript-heavy
3. **Dynamic Fetch**: Falls back to Playwright if needed

### 2. Data Extraction

Uses multiple strategies for each field:

- **Open Graph tags** (og:title, og:description, etc.)
- **Meta tags** (description, keywords)
- **CSS selectors** (class/id patterns)
- **Regex patterns** (dates, times, distances, fees)
- **Text analysis** (organizer keywords, address patterns)

### 3. Data Normalization

- **Dates**: Converts to ISO format (YYYY-MM-DD)
- **Times**: Converts to 24-hour format (HH:MM)
- **Distances**: Standardizes to common formats (5K, 10K, Half Marathon, etc.)
- **Text**: Cleans whitespace and normalizes formatting

## File Structure

```
scrapers/
├── race_scraper.py          # Main scraper module
├── example_usage.py         # Supabase integration examples
├── requirements.txt         # Python dependencies
├── .env.example            # Environment variables template
└── README.md               # This file
```

## Dependencies

### Required

- `requests` - HTTP requests
- `beautifulsoup4` - HTML parsing
- `python-dateutil` - Date parsing

### Optional

- `playwright` - JavaScript rendering (for SPAs)
- `supabase` - Supabase database client
- `python-dotenv` - Environment variable management

## Troubleshooting

### Playwright Not Working

```bash
# Install Playwright
pip install playwright

# Install Chromium browser
playwright install chromium

# On Linux, you may need additional dependencies
playwright install-deps
```

### No Data Extracted

- Check if the page is JavaScript-heavy (scraper will auto-detect)
- Inspect the page source to see if data is in HTML or loaded via JS
- Try using Playwright directly: `scraper._fetch_dynamic(url)`

### Supabase Connection Issues

- Verify `SUPABASE_URL` and `SUPABASE_KEY` in `.env`
- Check that the `marathons` table exists in your database
- Ensure your API key has insert permissions

### Date/Time Not Parsing

- The scraper uses `python-dateutil` which handles most formats
- If dates aren't extracted, check the page source for date patterns
- You may need to add custom regex patterns in `_extract_date()`

## API Reference

### `scrape_race(url: str) -> dict`

Main function to scrape race data.

**Parameters:**
- `url` (str): Race registration page URL

**Returns:**
- `dict`: Race data with fields (may be None if not found)

**Raises:**
- `ValueError`: If URL is invalid
- `Exception`: If page cannot be fetched

### `RaceScraper` Class

Main scraper class for advanced usage.

**Methods:**
- `scrape_race(url)`: Scrape race data from URL
- `_fetch_static(url)`: Fetch page with requests
- `_fetch_dynamic(url)`: Fetch page with Playwright
- `_extract_name(soup)`: Extract event name
- `_extract_date(soup)`: Extract event date
- `_extract_time(soup)`: Extract start time
- `_extract_location(soup)`: Extract location
- `_extract_distances(soup)`: Extract race distances
- `_extract_description(soup)`: Extract description
- `_extract_entry_fee(soup)`: Extract entry fee
- `_extract_organizer(soup)`: Extract organizer name

## Examples

### Example 1: Simple Scraping

```python
from race_scraper import scrape_race

# Scrape a race
data = scrape_race("https://dhakamarathon.com/signup")

# Access fields
print(f"Race: {data['name']}")
print(f"Date: {data['date']}")
print(f"Location: {data['location']}")
```

### Example 2: Save to JSON

```python
import json
from race_scraper import scrape_race

# Scrape
data = scrape_race("https://example.com/race")

# Save to file
with open("race.json", "w") as f:
    json.dump(data, f, indent=2)
```

### Example 3: Insert to Supabase

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

### Example 4: Batch Processing

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

## Contributing

To improve the scraper for specific race websites:

1. **Add CSS selectors**: Update `_extract_*` methods with site-specific selectors
2. **Add regex patterns**: Extend pattern matching for unique date/time formats
3. **Test thoroughly**: Ensure extraction works across multiple pages

## License

Part of the PacePack project.

## Support

For issues or questions:
- Check the troubleshooting section above
- Review the Supabase schema in `docs/supabase-schema.sql`
- Inspect page source to understand data structure

## Next Steps

- [ ] Add support for multiple distances in separate table
- [ ] Extract and download race images
- [ ] Add support for recurring events
- [ ] Implement caching to avoid re-scraping
- [ ] Add rate limiting for bulk scraping
- [ ] Create web interface for non-technical users
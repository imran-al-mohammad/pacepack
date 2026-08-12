# 🔗 PacePack Integration Guide

This guide explains how the race scraper is integrated into the PacePack app's "Add Marathon" flow.

## Overview

When adding a new marathon, users now have two options:

1. **Manual Entry**: Fill out the form manually (original behavior)
2. **URL Import**: Paste a race registration URL and auto-fill the form (new feature)

## How It Works

### User Flow

```
User clicks "+ Add Marathon"
    ↓
Modal opens with form
    ↓
User pastes URL in "Import from URL" field
    ↓
User clicks "Scrape" button
    ↓
[Edge Function] Fetches URL and extracts race data
    ↓
Confirmation dialog shows scraped data
    ↓
User reviews and edits if needed
    ↓
User clicks "Use This Data"
    ↓
Form fields are auto-filled
    ↓
User reviews and clicks "Save"
    ↓
Marathon saved to database
```

### Architecture

```
┌─────────────────┐
│   Frontend      │
│   (app.js)      │
│                 │
│ 1. User enters  │
│    URL          │
│ 2. Calls        │
│    sb.functions  │
│    .invoke()     │
└────────┬────────┘
         │
         │ Supabase Function Call
         │
         ↓
┌─────────────────┐
│ Edge Function   │
│ scrape-race     │
│                 │
│ 1. Fetches URL  │
│ 2. Parses HTML  │
│ 3. Extracts     │
│    data         │
│ 4. Returns JSON │
└────────┬────────┘
         │
         │ JSON Response
         │
         ↓
┌─────────────────┐
│   Frontend      │
│                 │
│ 1. Shows        │
│    confirmation │
│ 2. User edits   │
│ 3. Fills form   │
└─────────────────┘
```

## Files Modified

### 1. `src/js/app.js`

**Changes to `openMarathonForm` function:**

- Added URL input field (only for new marathons, not edits)
- Added "Scrape" button
- Added click handler to call the edge function
- Shows loading state while scraping

**New function: `showScrapeConfirmation`**

- Displays scraped data in an editable form
- Allows user to review and modify fields
- Maps scraped data to form fields
- Shows success message when confirmed

### 2. `supabase/functions/scrape-race/index.ts` (NEW)

**Edge Function: `scrape-race`**

- Receives URL in request body
- Fetches the page HTML
- Parses HTML using DOMParser
- Extracts race data using regex patterns
- Returns structured JSON data

**Extraction Logic:**

- **Name**: Open Graph tags → title tag → h1
- **Date**: Regex patterns for various date formats
- **Time**: Time patterns (HH:MM, AM/PM)
- **Location**: Location/venue patterns
- **Distances**: Marathon, Half Marathon, 10K, 5K, etc.
- **Deadline**: "deadline", "closes", "register by" patterns
- **Organizer**: "organized by", "presented by" patterns
- **Description**: Meta description or first paragraph
- **Entry Fee**: Currency patterns

## Data Flow

### Request (Frontend → Edge Function)

```javascript
const { data, error } = await sb.functions.invoke('scrape-race', {
  body: { url: "https://example.com/race-signup" }
})
```

### Response (Edge Function → Frontend)

```json
{
  "success": true,
  "data": {
    "name": "Dhaka Marathon 2026",
    "date": "2026-12-15",
    "start_time": "06:00",
    "location": "Dhaka, Bangladesh",
    "distances": ["Marathon", "Half Marathon", "10K", "5K"],
    "registration_url": "https://example.com/signup",
    "registration_deadline": "2026-11-30",
    "organizer": "Bangladesh Athletics Federation",
    "description": "Annual marathon event...",
    "entry_fee": "BDT 2500",
    "source_url": "https://example.com/signup"
  }
}
```

## Field Mapping

### Scraped Data → Form Fields

| Scraped Field | Form Field ID | Notes |
|---------------|---------------|-------|
| `name` | `m-name` | Direct mapping |
| `date` | `m-date` | Already in YYYY-MM-DD format |
| `start_time` | `m-time` | Already in HH:MM format |
| `location` | `m-location` | Direct mapping |
| `distances[0]` | `m-distance` | First matching distance |
| `registration_deadline` | `m-close-date` | Registration close date |
| `description` | `m-notes` | Goes to notes field |
| `registration_url` | `m-reg-link` | Registration URL |
| `organizer` | (not mapped) | Could be added to notes |

## Error Handling

### Frontend Errors

- **Invalid URL**: Shows toast "URL must start with http:// or https://"
- **Empty URL**: Shows toast "Please enter a URL"
- **Scraping Failed**: Shows toast with error message
- **No Data Received**: Shows toast "No data received from scraper"

### Edge Function Errors

- **Missing URL**: Returns 400 with error message
- **Invalid URL**: Returns 400 with error message
- **HTTP Error**: Returns 500 with status code
- **Parse Error**: Returns 500 with error message

## Styling

The confirmation dialog uses the existing modal system with:

- `wide: true` - Makes the modal wider for better readability
- Form grid layout for organized field display
- Panel hints for user guidance
- Standard button styling

## Testing

### Manual Testing

1. Open PacePack app
2. Navigate to Marathons view
3. Click "+ Add Marathon"
4. Paste a race URL in the "Import from URL" field
5. Click "Scrape"
6. Review the confirmation dialog
7. Edit any fields if needed
8. Click "Use This Data"
9. Verify form is filled correctly
10. Click "Save"

### Test URLs

Try these sample URLs (if they exist):

- `https://example.com/marathon-signup`
- `https://dhakamarathon.com/register`
- Any race registration page with structured data

## Deployment

### Deploy Edge Function

```bash
# Deploy the scrape-race function
supabase functions deploy scrape-race

# Set function secrets (if needed)
supabase secrets set SCRAPER_API_KEY=your-key
```

### Enable in Supabase

1. Go to Supabase Dashboard
2. Navigate to Edge Functions
3. Verify `scrape-race` function is deployed
4. Check function logs for errors

## Limitations

### Current Limitations

1. **JavaScript-Heavy Pages**: The edge function uses basic HTTP fetching, not a full browser. Pages that require JavaScript to render content may not work well.

2. **Rate Limiting**: No rate limiting on the edge function. Consider adding limits for production use.

3. **CORS**: The edge function fetches URLs server-side, so CORS is not an issue. However, some sites may block server requests.

4. **Data Accuracy**: Extraction accuracy depends on page structure. Not all pages will have all fields.

### Future Improvements

1. **Playwright Integration**: Use Playwright in edge functions for JavaScript-heavy pages
2. **Caching**: Cache scraped data to avoid re-scraping the same URL
3. **Custom Selectors**: Allow per-site custom extraction rules
4. **Image Extraction**: Extract and download race images
5. **Batch Import**: Import multiple races at once

## Troubleshooting

### "Failed to scrape race data"

- Check if URL is accessible
- Verify URL starts with http:// or https://
- Check edge function logs in Supabase dashboard

### "No data received from scraper"

- The page may not have extractable data
- Try a different race registration page
- Check if the page requires JavaScript

### Form not filling after confirmation

- Check browser console for errors
- Verify form field IDs match (m-name, m-date, etc.)
- Ensure confirmation dialog is not being blocked

## Security Considerations

1. **URL Validation**: Only http/https URLs are allowed
2. **Server-Side Fetching**: URLs are fetched server-side to avoid CORS and hide user IP
3. **Input Sanitization**: All scraped data is sanitized before display
4. **Rate Limiting**: Consider adding rate limiting for production

## Support

For issues or questions:

1. Check the main scraper documentation in `scrapers/README.md`
2. Review edge function logs in Supabase dashboard
3. Test with the Python scraper locally first
4. Check browser console for frontend errors

---

**Status**: ✅ Integration complete and ready for testing
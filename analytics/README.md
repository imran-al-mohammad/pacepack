# PacePack analytics

Python engine that turns live club data into metrics and plain-language insights.

## Files

| File | Role |
|------|------|
| `insights.py` | Source of truth for analytics formulas |
| `export_js.py` | Writes browser-ready `../insights.js` |
| `../insights.js` | Loaded by the dashboard |

## Regenerate JS after formula changes

```bash
python analytics/export_js.py
```

## Self-check

```bash
python analytics/insights.py
```

## What it measures

- Participation rate (runners with ≥1 entry)
- Average signups per race
- PR rate and timed-result medians/averages
- Busiest race, empty races, most active runner
- Distance mix, interested/waitlist follow-ups
- Runners who improved latest time vs earliest

The dashboard calls `PacePackAnalytics.analyze({ runners, marathons, registrations })` on every render.

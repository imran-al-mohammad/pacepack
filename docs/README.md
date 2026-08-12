# PacePack — Online Group Race Tracker

A full-featured, multi-user web app for running clubs to track marathons, runners, registrations, and results in real time. Built as a static PWA (GitHub Pages) backed by [Supabase](https://supabase.com) for authentication, database, and push notifications.

**Roles:** Admin · Moderator · Member

---

## Features

- **Group-based access** — each club creates a group with an invite code; all data is shared live within the group
- **Role-based permissions** — Admin, Moderator, and Member roles with granular capabilities
- **Marathon tracking** — add races with dates, registration links, images, and race times
- **Runner roster** — one runner per app member per group, with pace groups, join dates, and public profiles
- **Registration & results** — track who's signed up, waitlisted, completed, or DNS/DNF; record finish times and age-group placements
- **Personal records** — store best times per distance with pace calculations
- **Achievement badges** — award badges like "First Marathon", "Sub-4", "1000 km Club"
- **Analytics dashboard** — participation rates, PR rates, busiest races, distance mix, and improvement tracking
- **Push notifications** — web push for race reminders and result updates (via Supabase Edge Functions)
- **Offline support** — PWA with service worker caching for offline access to the app shell
- **Client-side caching** — TTL-based localStorage cache for profiles, leaderboards, and more

---

## Quick Start

### 1. Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Wait until the project is ready

### 2. Configure Authentication

**Authentication → Providers → Email**

- Enable **Email**
- Turn **Confirm email OFF** (recommended for clubs; otherwise users must click a confirmation link)

### 3. Apply the Database Schema

1. **SQL Editor → New query**
2. Paste the entire contents of `docs/supabase-schema.sql`
3. Click **Run**

### 4. Apply Migrations

Run `docs/MIGRATE-ALL.sql` in the SQL Editor to add all missing columns, tables, functions, indexes, and RLS policies. This script is idempotent and safe to re-run.

Then run `docs/automated-analytics.sql`. It backfills system PRs, historical PR flags, earned badges, and runner join dates from registrations and race dates. It also installs the registration trigger and the authenticated `recalculate_group_analytics(group_id)` RPC for future recalculation. Re-running it is safe; automated PR rows are rebuilt from canonical results and unknown/manual badge keys are preserved.

### 5. Configure the App

Edit `config.js` with your Supabase URL and anon key:

```js
window.PACEPACK_CONFIG = {
  supabaseUrl: "https://YOUR_REF.supabase.co",
  supabaseAnonKey: "eyJ....your_anon_key....",
};
```

> Use the **anon** key only. Never put `service_role` in the frontend.

### 6. Deploy

Commit and push to GitHub so Pages updates. Or open `index.html` locally for development.

### 7. First Admin Setup

1. Open your site
2. **Create account** (your email + password)
3. **Create a new group** → you become **Admin**
4. Open **Team & access** to create users or share the invite code

---

## Project Structure

```
pacepack/
├── index.html                          # Main app entry (root for GitHub Pages)
├── offline.html                        # Offline fallback
├── manifest.webmanifest                # PWA manifest
├── sw.js                               # Service Worker
├── config.js                           # App configuration
│
├── src/
│   ├── js/
│   │   ├── app.js                      # Main application logic
│   │   ├── cache.js                    # Client-side cache utility
│   │   ├── cache-examples.js           # Cache usage examples
│   │   └── insights.js                 # Analytics engine
│   └── css/
│       └── styles.css                  # All styles
│
├── public/
│   └── icons/                          # PWA icons
│       ├── icon-48.png
│       ├── icon-72.png
│       ├── ... (all icon files)
│       └── icon.svg
│
├── analytics/                          # Python analytics tools
│   ├── export_js.py
│   ├── insights.py
│   └── README.md
│
├── supabase/
│   └── functions/                      # Supabase edge functions
│       └── send-notifications/
│           └── index.ts
│
└── docs/                               # Documentation and SQL scripts
    ├── README.md
    ├── ONLINE-SETUP.md
    ├── CODE-REVIEW-FIXES.md
    ├── supabase-schema.sql
    ├── profile-schema.sql
    ├── notifications-schema.sql
    ├── add-admin-create-user.sql
    ├── add-group-branding-fetch.sql
    ├── add-image-url-columns.sql
    ├── add-registration-fields.sql
    ├── fix-relationships.sql
    ├── MIGRATE-ALL.sql
    ├── moderator-create-users-runners.sql
    └── generate_icons.py
```

---

## Roles & Permissions

| Action | Admin | Moderator | Member |
|--------|:-----:|:---------:|:------:|
| View everything | ✓ | ✓ | ✓ |
| Add/edit runners, races, results | ✓ | ✓ | ✓ |
| Delete runners, races, registrations | ✓ | ✓ | — |
| **Create users** (email + password) | ✓ | — | — |
| Change roles / remove users | ✓ | — | — |
| Invite code | ✓ (share) | share | share |

---

## Analytics

The analytics engine lives in `analytics/insights.py` and is exported to `src/js/analytics/insights.js` via `analytics/export_js.py`. The dashboard calls `PacePackAnalytics.analyze({ runners, marathons, registrations })` on every render.

### Source layout

Runtime JavaScript is grouped by responsibility: `src/js/services/` contains reusable browser services, `src/js/analytics/` contains the generated analytics client, and `src/js/dev/` contains optional development examples. The static entry points remain at the repository root for GitHub Pages compatibility.

**Metrics include:**

- Participation rate (runners with ≥1 entry)
- Average signups per race
- PR rate and timed-result medians/averages
- Busiest race, empty races, most active runner
- Distance mix, interested/waitlist follow-ups
- Runners who improved latest time vs earliest

To regenerate the JS after formula changes:

```bash
python analytics/export_js.py
```

---

## Push Notifications

The `supabase/functions/send-notifications/index.ts` Edge Function sends web push notifications to subscribed users. It requires:

- **VAPID keys** — generate with `npx web-push generate-vapid-keys`
- **Environment variables** in Supabase:
  - `VAPID_PUBLIC_KEY`
  - `VAPID_PRIVATE_KEY`
  - `VAPID_SUBJECT` (e.g., `mailto:admin@pacepack.app`)
  - `CRON_SECRET` (for authenticating scheduled invocations)
- **Supabase cron** or external scheduler to invoke the function periodically

---

## Development

### Prerequisites

- Python 3.x (for icon generation and analytics export)
- PIL/Pillow (`pip install pillow`) — for `generate_icons.py`
- A Supabase project with the schema applied

### Regenerating Icons

```bash
python docs/generate_icons.py
```

### Regenerating Analytics

```bash
python analytics/export_js.py
```

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| Connect Supabase screen | Fill `config.js` and redeploy |
| Invalid invite code | Check code under Team & access; re-run SQL if tables missing |
| Confirm email message | Disable email confirmation in Auth settings |
| Permission denied | Role too low, or RLS/SQL not applied |
| Relation does not exist | Re-run `docs/supabase-schema.sql` |

---

## Migration from Old "Room" Version

The old `pacepack_rooms` table is no longer used. Create a new group, re-add races/runners, or export from the old app if you still have a local backup.

---

## License

This project is provided as-is for running clubs and community use.

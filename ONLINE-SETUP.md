# PacePack — Shared online setup

The app works offline by default. Follow this once to give your group a **shared live copy** on every phone and laptop.

## What you get

- One **room code** for the whole group  
- Live sync of marathons, members, registrations, **results & times**  
- A **share link** you can send (after hosting the website)

Free tier (Supabase) is enough for a running club.

---

## Part A — Database (Supabase)

1. Sign up at [https://supabase.com](https://supabase.com) and **New project**.
2. Wait until the project is ready.
3. Open **SQL Editor** → **New query**.
4. Paste everything from `supabase-schema.sql` in this folder → **Run**.
5. Open **Project Settings → API** and copy:
   - **Project URL** (`https://xxxx.supabase.co`)
   - **anon public** key (long `eyJ...` string)  
   Do **not** use the `service_role` key in the app.

---

## Part B — Connect the app

### Option 1 — In the UI (easiest)

1. Open `index.html` (or your hosted URL).
2. Go to **Shared online**.
3. Paste URL + anon key → **Save connection**.
4. Click **Create room** (uses the data already on this device).
5. Copy the **room code** or **share link**.

Teammates:

1. Open the same app URL.
2. Paste the same Supabase URL + anon key (or you prefill `config.js` — see below).
3. **Join room** with the code, **or** open the share link `...?room=CODE`.

### Option 2 — Prefill for everyone (`config.js`)

Edit `config.js` before you host the site:

```js
window.PACEPACK_CONFIG = {
  supabaseUrl: "https://YOUR_REF.supabase.co",
  supabaseAnonKey: "YOUR_ANON_KEY",
};
```

Then the group only needs the room code / link — no keys to type.

> The anon key is meant for browsers. Security for PacePack is the **room code** (treat it like a password). Do not put medical/payment data in the app.

---

## Part C — Host the website (free)

So people don’t need the files on their PC:

### GitHub Pages

1. Create a GitHub repo and upload this folder’s files.
2. **Settings → Pages → Deploy from branch** (`main` / root).
3. Open `https://YOURUSER.github.io/REPO/`  
4. Append `?room=YOURCODE` for a direct join link.

### Netlify Drop (fastest)

1. Go to [https://app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag the `marathon-manager` folder onto the page.
3. Use the URL Netlify gives you + `?room=CODE`.

### Cloudflare Pages

1. New project → upload the folder or connect Git.
2. Build command: none · output directory: `/` (static).

---

## Day-to-day use

| Action | How |
|--------|-----|
| Add a race / member | Same as local — saves and syncs if you’re in a room |
| Enter finish times | **Results & times** or edit a registration |
| See group leaderboard | **Results & times** → pick race |
| Invite someone | Share link or 6-character room code |
| Leave shared mode | **Shared online → Leave room** (keeps a local copy) |
| Backup | **Export** JSON anytime |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| “Table missing” | Run `supabase-schema.sql` again |
| “Invalid API key” | Use **anon** key, not service_role; check URL |
| Join says room not found | Wrong code, or room never created |
| No live updates | In Supabase: Database → Replication → ensure `pacepack_rooms` is in `supabase_realtime` (the SQL script does this) |
| Two people overwrite each other | Last save wins — edit different fields / wait a second between big imports |

---

## Privacy note

Room data is readable by anyone who has your **project anon key + room code**.  
For a private club that is usually fine. Rotate the room (create a new one) if a code leaks.

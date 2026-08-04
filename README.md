# PacePack — Marathon Group Manager

Track **races**, **who from your group registered**, and **finish results & times**.  
Works offline on one device, or **shared online** so the whole group stays in sync.

## Open locally

1. Open folder: `Documents\marathon-manager`
2. Double-click **`index.html`**

## Features

### Marathons & members
- Races: name, date, distance, location, notes  
- Group roster: contact + notes  
- Registrations with status: Interested → Registered → Waitlisted → Completed / DNS / DNF  

### Results & times
- **Gun time** and **chip / net time** (`H:MM:SS` or `M:SS`)  
- Auto **pace** (per km & per mile) from distance + finish time  
- Overall / gender / age-group **place**  
- **PR** flag and result notes  
- Per-race **leaderboard** with group best, median, finisher count  

### Shared online
- Free **Supabase** backend (see `ONLINE-SETUP.md`)  
- Create or join a **room code**  
- Live sync across phones and laptops  
- Share link: `yoursite.com/?room=ABC123`  

### Backup
- Export / import JSON from the sidebar  

## Shared online (short version)

1. Free project at [supabase.com](https://supabase.com)  
2. Run `supabase-schema.sql` in the SQL Editor  
3. Paste Project URL + **anon** key under **Shared online**  
4. **Create room** → send code or link to the group  
5. Host this folder on **GitHub Pages** or **Netlify Drop** so everyone uses one URL  

Full walkthrough: **`ONLINE-SETUP.md`**

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell |
| `styles.css` | UI |
| `app.js` | Logic, results, sync |
| `config.js` | Optional prefilled Supabase keys |
| `supabase-schema.sql` | Database setup |
| `ONLINE-SETUP.md` | Shared hosting guide |

## Tips

- Chip time is preferred for pace when both gun and chip are set.  
- Entering a finish time auto-sets status to **Completed** (unless DNS/DNF).  
- Demo data appears on first launch — replace with your group.  
- Export a backup before big imports or when switching rooms.  

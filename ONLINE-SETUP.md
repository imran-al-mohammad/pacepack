# PacePack — full online setup

This version is **multi-user and online-only**:

- Accounts (email + password)
- Shared live data for the whole club
- Roles: **Admin**, **Moderator**, **Member**

---

## 1. Supabase project

1. Go to [supabase.com](https://supabase.com) → New project  
2. Wait until the project is ready  

### Auth settings

**Authentication → Providers → Email**

- Enable Email  
- Turn **Confirm email OFF** (easiest for a club; otherwise users must click a confirm link)

### Database

1. **SQL Editor → New query**  
2. Paste **all** of `supabase-schema.sql`  
3. **Run**  

### API keys

**Project Settings → API**

- Copy **Project URL**  
- Copy **anon public** key  

---

## 2. Put keys in the app

Edit `config.js`:

```js
window.PACEPACK_CONFIG = {
  supabaseUrl: "https://YOUR_REF.supabase.co",
  supabaseAnonKey: "eyJ....your_anon_key....",
};
```

Commit and push to GitHub so Pages updates.

> Use the **anon** key only. Never put `service_role` in the frontend.

---

## 3. First Admin setup

1. Open your site, e.g. `https://imran-al-mohammad.github.io/pacepack/`  
2. **Create account** (your email + password)  
3. **Create a new group** → you become **Admin**  
4. Open **Team & access**  
5. Copy the **invite code** or **invite link**  

---

## 4. Invite the group

Share either:

- Invite link: `https://yoursite/pacepack/?invite=YOURCODE`  
- Or the 8-character code  

They:

1. Open the link (or the site)  
2. Create their own account / sign in  
3. Auto-join via link, or enter the code  
4. Join as **Member**  

You (Admin) can promote people to **Moderator** or **Admin** under **Team & access**.

---

## Roles

| Action | Admin | Moderator | Member |
|--------|:-----:|:---------:|:------:|
| View everything | ✓ | ✓ | ✓ |
| Add/edit runners, races, results | ✓ | ✓ | ✓ |
| Delete runners, races, registrations | ✓ | ✓ | — |
| Change roles / remove users | ✓ | — | — |
| Invite code | ✓ (share) | share | share |

---

## Notes

- **Runners** = people on the race roster (may not have logins)  
- **Team & access** = people who can log into the app  
- Data syncs live for everyone in the group  
- Old local-only / room JSON mode is replaced by this schema  

### If something fails

| Error | Fix |
|-------|-----|
| Connect Supabase screen | Fill `config.js` and redeploy |
| Invalid invite code | Check code under Team & access; re-run SQL if tables missing |
| Confirm email message | Disable email confirmation in Auth settings |
| Permission denied | Role too low, or RLS/SQL not applied |
| Relation does not exist | Re-run `supabase-schema.sql` |

### Migrating from the old “room” version

The old `pacepack_rooms` table is not used anymore. Create a new group, re-add races/runners, or export from the old app if you still have a local backup.

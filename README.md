# PacePack — Online Marathon Group Manager

Full **online**, multi-user race tracker for a running club.

- Sign in with email/password  
- Shared live data (Supabase)  
- Roles: **Admin**, **Moderator**, **Member**  
- Marathons, runners, registrations, finish times & results  

## Quick start

1. Create a free [Supabase](https://supabase.com) project  
2. Run `supabase-schema.sql` in the SQL Editor  
3. Disable **Confirm email** (Auth → Email) for easiest club onboarding  
4. Put Project URL + **anon** key in `config.js`  
5. Host on GitHub Pages (or open `index.html` locally)  
6. Create an account → **Create group** (you are Admin)  
7. Share invite link from **Team & access**  

Full details: **[ONLINE-SETUP.md](ONLINE-SETUP.md)**

## Roles

| | Admin | Moderator | Member |
|--|:-----:|:---------:|:------:|
| View / edit races, runners, results | ✓ | ✓ | ✓ |
| Delete races, runners, registrations | ✓ | ✓ | |
| Manage user roles & remove access | ✓ | | |

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell + auth screens |
| `styles.css` | UI |
| `app.js` | Auth, roles, live CRUD |
| `config.js` | Supabase URL + anon key |
| `supabase-schema.sql` | Database, RLS, RPCs |
| `ONLINE-SETUP.md` | Setup guide |

## Local testing

Fill `config.js`, then open `index.html` in a browser (or use a static server).

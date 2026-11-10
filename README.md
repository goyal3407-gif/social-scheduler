# Social Scheduler by Goyal Kumar

A free-forever social media scheduler for anyone — schedule Instagram Reels and posts, manage a media library, bulk-schedule from links or CSV, and publish directly to Instagram via the Instagram Graph API.

## Features

- **Home dashboard** — next post countdown, overdue posts with one-tap "Publish due", publishing streak (real data), getting-started checklist, stats
- **Calendar** — month view, tap a day to see its posts, reschedule ±1 day and "next best time"
- **Queue** — list + Kanban board, filters, search, bulk select/delete, CSV export, duplicate/reschedule/next-best-time, overdue banner
- **Studio** — live phone preview, caption score, hashtag limit warning, Reel-safety check (dimensions auto-detected from the media), duplicate-media and time-collision warnings, timeless drafts
- **Bulk** — paste links or import a CSV (paste or .csv file), skip-duplicates, auto-spacing (one post per day at 7pm)
- **Media Library** — upload videos (about 4 MB max per upload on the live site — bigger files: add by link) or save links, folders, tags, favourites, search, paginated grid, dimensions stored per item
- **Tools** — content-health analytics with failure-reason breakdown, hashtag vault, hooks library, content bank, best-time heatmap built from your own posting pattern (guide until 10+ timed posts), reply helper, templates
- **AI Studio** — Reel Writer (hooks + script + caption), Weekly Plan (7-day calendar, one-tap add as drafts), Profile Audit (real connected data only, no invented numbers), Viral Ideas with "make it mine" rewrites, Reply Helper (3 draft replies, never auto-sent); niche remembered per device
- **Instagram publishing** — publish scheduled Reels from the website via the Instagram Graph API (media_type `REELS`); **auto-publish**: "Publish due" button, plus a cron endpoint (see below) so due posts go live on a schedule without a tap
- **Account** — change password, download your data (JSON export), delete account; Instagram token age warning (tokens last ~60 days)

## Auto-publish (cron)

The scheduler can publish due posts by itself. Two parts:

1. **Manual:** Dashboard / Queue → "Publish due" publishes every scheduled post whose time has passed (max 5 per tap), and retries a failed post once if it failed less than twice.
2. **Automatic:** `POST /api/cron/publish-due` with header `Authorization: Bearer <CRON_SECRET>` publishes due posts for every user (max 3 per user per run). Set `CRON_SECRET` in Vercel env vars, then add a Vercel Cron Job (Hobby: daily) hitting `https://<your-domain>/api/cron/publish-due` every 15 minutes (or daily — due posts publish on the next run). Without `CRON_SECRET` the endpoint refuses to run.

## Run locally

```bash
npm install
npm run build
npm start
```

Open http://localhost:3000 — create an account (the first account is the owner),
then the setup wizard walks through connecting Instagram and importing your
existing Instagram posts. Either wizard step can be skipped.

## Environment variables

Set these in Vercel (Project Settings → Environment Variables, **all
environments**). Never put real values in the repo.

- `MONGODB_URI` — **required on Vercel.** MongoDB Atlas connection string.
  The app stores users, sessions, posts, media, templates, settings, the
  Instagram token and import jobs in its own database (`social_scheduler`,
  a separate database in the same Atlas cluster as PureNest — the code
  forces `dbName: 'social_scheduler'`). Without it the app falls back to
  local JSON files, which disappear on every Vercel redeploy/cold start.
  Check status at `GET /api/db-status` (also shown in Settings).
- `SESSION_SECRET` — **required on Vercel.** Long random string that signs
  the login session cookie. Without it a random per-process secret is used
  and everyone is logged out on each restart/redeploy.
- `TOKEN_ENCRYPTION_KEY` — optional. Key that encrypts the stored Instagram
  token at rest (AES-256-GCM). Defaults to `SESSION_SECRET` when not set.
- `CRON_SECRET` — optional but recommended for auto-publish. Long random
  string; the cron endpoint `POST /api/cron/publish-due` only runs when
  called with `Authorization: Bearer <CRON_SECRET>`. Generate with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `INSTAGRAM_ACCESS_TOKEN` / `IG_USER_ID` — optional fallback for Instagram
  publishing when no token has been pasted in Settings. Pasting a token in
  Settings (verified live against the Graph API) takes priority.

## Deploy on Vercel (free, Hobby)

1. Import this repo in Vercel, Framework Preset **Vite**, Root Directory = repo root.
2. Set environment variables in Vercel (all environments): `MONGODB_URI`
   and `SESSION_SECRET` (required — see above), plus `INSTAGRAM_ACCESS_TOKEN`
   / `IG_USER_ID` if you want Instagram publishing without pasting a token.
   Make sure the Atlas cluster allows Vercel's IPs (Atlas Network Access:
   allow `0.0.0.0/0`, or the Vercel IPs).
3. Deploy to Production. The API function runs with `maxDuration: 60`
   (see `vercel.json`) so Instagram publish polling (max ~45s) fits.
4. Verify: open `/api/db-status` — it must say `"db": "mongodb"` and
   `"sessionSecretFromEnv": true`. Without those, accounts and posts will
   not survive redeploys and logins will keep breaking.
5. Without the Instagram variables, the app still works fully for scheduling
   and the library; Publish shows a clear "connect Instagram token" state.

## Limits on the live site (Vercel serverless)

- File uploads: about 4 MB max per request (Vercel request limit) and
  about 9 MB max stored per file (MongoDB document limit). Bigger files:
  add them by public link instead.
- Instagram publish: polling is capped at ~45s; if a video is still
  processing, press Publish again — it resumes the same container instead
  of duplicating the post.

Made by Goyal Kumar. Free forever.

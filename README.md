# Social Scheduler by Goyal Kumar

A free-forever social media scheduler for anyone — schedule Instagram Reels and posts, manage a media library, bulk-schedule from links or CSV, and publish directly to Instagram via the Instagram Graph API.

## Features

- **Home dashboard** — next post countdown, publishing progress, streak, stats
- **Calendar** — month view, tap a day to see its posts, shift posts ±1 day
- **Queue** — list + Kanban board, filters, copy caption, reschedule, CSV export
- **Studio** — live phone preview, caption score, pre-publish checklist, hashtag sets, best-time picker, 30-hashtag warning, Reel-safety check
- **Bulk** — paste links or import a Byvano-format CSV (`Media,Caption,Hashtags,CTA,Platform,Schedule Time`)
- **Media Library** — upload videos (up to 60 MB) or save links, folders, tags, favourites, search
- **Tools** — content-health analytics, hashtag vault, hooks library, content bank, best-time heatmap, reply helper, templates
- **Instagram publishing** — publish scheduled Reels from the website via the Instagram Graph API (media_type `REELS`)

## Run locally

```bash
npm install
npm run build
npm start
```

Open http://localhost:3000

## Deploy on Vercel (free, Hobby)

1. Import this repo in Vercel, Framework Preset **Vite**.
2. Deploy to Production.
3. Optional — Instagram publishing: set environment variables in Vercel (all environments):
   - `INSTAGRAM_ACCESS_TOKEN` — system-user token from the Meta app
   - `IG_USER_ID` — Instagram Business Account ID (e.g. `17841434171126389`)
4. Without those variables, the app still works fully for scheduling and the library; Publish shows a clear "connect Instagram token" state.

Made by Goyal Kumar. Free forever.

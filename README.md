# BMV Portfolio Ledger

Live portfolio tracker for the Strategic Ventures team. Static page, Supabase for data,
auth and realtime. No build step.

## Files
- `index.html` — the whole application
- `config.js` — Supabase project URL and anon key
- `supabase-schema.sql` — run once in the Supabase SQL editor

## Setup
1. Create a project at supabase.com
2. SQL Editor → New query → paste `supabase-schema.sql` → Run
3. Authentication → Providers → Email: turn **Confirm email** off
4. Authentication → Users → add one user per person
5. Put the project URL and anon key into `config.js`
6. Table editor → `profiles` → set each person's `role`

## Local preview
    npx serve .

## Deploy
Push to GitHub, import the repo at vercel.com, deploy. No build command, output is the repo root.

# BMV Portfolio Ledger

One page app for the Banque Misr Ventures Strategic Ventures team to track its
portfolio: legal position, investment position and value creation, per company.
It replaces `Portfolio_Dashboard_v4.xlsx` (still in the parent folder as the
original source). Five roles review it and edits are live for everyone.

Production: https://portfolio-management-five-cyan.vercel.app

## Architecture

- **One static `index.html`.** No framework, no bundler, no build step. Plain
  ES5-style JavaScript in a single `<script id="app">`. Do not introduce a build
  step without a reason: Vercel serves the repo root as is.
- **Supabase** is the entire backend: Postgres, email/password auth, realtime.
- **Vercel** deploys on push to `main`. No build command, output directory `./`.
- `config.js` holds the project URL and anon key. The anon key is a public client
  key by design; row level security is what actually guards the data.
- **One deliberate exception to "no build step":** `middleware.ts` is Vercel
  Routing Middleware, a soft link-share gate in front of the whole site (cookie
  `dashboard_access`, unlocked by visiting with `?access=bmv2026`, rewrites
  everyone else to `404.html`). It needs `package.json` and the `@vercel/functions`
  dependency to build. **This is not real security** — it's a shared secret sitting
  in plaintext in the repo, meant only to keep the URL from being casually
  stumbled on or indexed before someone signs in. Supabase Auth is still the
  actual access control; do not remove it or treat the middleware as a
  replacement for it.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The whole application |
| `config.js` | Supabase URL and anon key |
| `supabase-schema.sql` | Schema plus seed. Idempotent, safe to re-run |
| `launch.sh` | Clears git locks and pushes |
| `middleware.ts` | Soft link-share gate (see Architecture) |
| `api/daily-brief.js` | Daily portfolio brief: reads Supabase, emails it. Cron'd by `vercel.json` |
| `lib/pdf.js` | Minimal PDF writer for the brief's attachment. Outside `api/` on purpose: anything in `api/` becomes an endpoint |
| `vercel.json` | Cron schedule for the brief (04:00 UTC = 7am Cairo in summer) |
| `404.html` | Shown to anyone the middleware gate blocks |
| `package.json`, `package-lock.json` | Only exist for `middleware.ts`'s `@vercel/functions` dependency |

## Daily brief

`api/daily-brief.js` builds the morning brief and emails it. It is dependency
free on purpose: Supabase and Resend are both plain REST, so nothing is
installed for it. `buildBrief()` is exported separately from the handler so the
output can be rendered and checked without sending anything.

- The brief is organised by **person**, not by company: one block each for Mina,
  Rafik and Reem. Each row carries the company, how late it is, that person's
  action lines, and the status with its due date. Under the actions sits one
  line of context: `issue_title` when the company has one, falling back to the
  first line of the newest history entry (`issueLine()`). The fallback is the
  guess `issue_title` was created to replace, so a company without a title
  reads noticeably worse — that is the prompt to give it one. How a company
  reaches a desk is set out below.
- The header shows the newest `updated_at` across the tracker. There is no
  `asOf` setting any more: it was maintained by hand and went stale.
- The activity window is **three days**, not one, and falls back to the five
  most recent entries when nothing is in the window. A 24-hour window went
  blank on a quiet day, which is when the reader most needs the context.
- **A desk is built from two things.** *Your move* is the `next_action` lines
  tagged to that person — a line may begin `Mina:`, `Rafik:`, `Reem:` or
  `Reem, Rafik:`, parsed by `parseAction()`, and only a prefix made entirely of
  known names counts so ordinary text like `Note:` survives. An untagged line
  falls to the company's `owner`. *Chasing* is the channel each person runs:
  **Pending company is Rafik's, Pending legal is Mina's**, shown as "with the
  companies" / "with counsel" and only when that company has no line tagged to
  them already. One company can therefore sit on several desks with different
  work, which is the point — Mina approves Flend's extension notice while Reem
  and Rafik decide the follow-on. Anything reaching no desk appears under
  **Unassigned**.
- The brief is **always dark**, not "dark if the reader is". Email cannot carry
  a media query reliably, so the palette is written as literals (the app's dark
  theme), with `color-scheme: dark`, `bgcolor` attributes, and `[data-ogsc]`
  overrides to stop Outlook and Gmail inverting the ground back to white under
  light text. Do not reintroduce light values here.
- **Every send carries a PDF**, built by `briefPdf()` on top of `lib/pdf.js`.
  Written by hand for the same reason as the Excel export: no service, no key,
  and the morning job cannot fail because someone else's API is down. It is laid
  out from `brief.pdfData` rather than converted from the HTML, so the two carry
  the same content without the PDF depending on the markup. If it throws, the
  email still goes and the response says `pdf: failed`.
- Desks render as a **grid** — company, what to do, status and due in fixed
  columns with zebra rows — not as prose blocks. The per-company timelines were
  removed with it: between them they made the brief too long to read at 7am.
- The PDF **flows its sections** rather than giving each its own page, breaking only when one would start with
  too little room beneath it. Each opens with a sentence saying what it is for.
  Page 1 carries the masthead, the executive summary (exposure in principal,
  what falls due inside a week, each desk's count) and usually the first desk.
  Grid rows are placed with `keepTogether()` so none is split across a page.
- `lib/pdf.js` supplies what PDF itself lacks: Helvetica and Helvetica-Bold
  character widths, a greedy wrapper, a cursor that starts a new page when it
  runs out of room, and `measure()`/`keepTogether()`, which run a block with
  output and pagination suppressed to find its height before placing it — so a
  block can be kept whole without duplicating its layout arithmetic. The document is ASCII only (`ascii()` transliterates), so
  nothing depends on the reader's encoding.
- `?pdf=1` returns the PDF without sending.
- It needs the **service role** key, not the anon key: RLS grants only
  `authenticated`, and a cron has no session.
- `?preview=1` returns the HTML without sending.
- **Three ways to authorise it**: the cron's bearer `CRON_SECRET`, `?key=` for a
  browser preview, or a **signed-in person's Supabase session token**, which is
  how the Send now / Preview buttons on the Dashboard work. The app is a public
  static page and cannot hold `CRON_SECRET`, so it presents the session token it
  already has and `isSignedIn()` verifies it against `/auth/v1/user` rather than
  decoding the JWT locally, so an expired or revoked token is refused. That path
  needs `SUPABASE_ANON_KEY`; it falls back to the service role key if unset.
- `middleware.ts` excludes `api/` so the cron can reach it; a scheduled request
  will never carry the browser gate cookie.

Environment, all set in Vercel and never in the repo: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `BRIEF_TO`, `BRIEF_FROM`,
`CRON_SECRET`, and optionally `SUPABASE_ANON_KEY`.

## Data model

Tables: `companies` (12 rows), `history` (58 rows), `messages`, `settings`
(key/jsonb), `profiles` (one per auth user, carries `role`).

JavaScript uses camelCase, Postgres uses snake_case. The mapping lives in the
`CO_COLS` object; `rowToCo()` and `patchToRow()` translate. Add a column in three
places: the SQL, `CO_COLS`, and wherever it renders.

`settings` keys: `lists`, `fx`, `dashNote`, `sources`, `reading`,
`triggerMap`, `investments`.

## Code conventions

- **Latest Situation is not stored. It is the newest `history` entry for that
  company**, resolved by `latestSituation()`, which **skips entries sourced
  `Action completed`**. Ticking a next action logs one of those, prefixed
  `Completed:`, and it renders as a green check beneath the situation rather
  than replacing it: finishing a task is not the same as the position having
  changed. `latestHistory(c, true)` includes them where the full log is wanted. There is no `situation` column and
  nothing should reintroduce one: the two used to hold the same events in two
  places and had already drifted apart. The situation box in "Edit status &
  action" writes a history row rather than a column, so updating the situation
  and logging history are the same act, and the log stays chronological.
  Ordering is `entry_date` desc, then `created_at` desc to break same-day ties.
- Everything renders from one `state` object. Render functions read `state` and
  nothing else; never fetch inside a render.
- Writes go through `saveCompany` / `addMessage` / `removeMessage` / `addHistory`
  / `saveSetting`. Each applies the change locally first, renders, then hits the
  database, and reverts on error.
- `loadAll()` refetches everything and re-renders. The realtime handler just
  calls it. Row level granularity is not worth the complexity at 12 rows.
- **Never use `window.confirm`, `alert` or `prompt`.** They are blocked in some
  embedding contexts and fail silently. Use `askConfirm(title, body, label, cb)`.
- Run every user supplied string through `esc()` before it reaches `innerHTML`.
- Roles come from `profiles.role`, never from client state.

## Design

Identity is taken from the ISV slide template. Maroon `#7B1F2C`, deep `#5E1621`,
bright `#A72A30`, gold `#C9A227`. Archivo for text, IBM Plex Mono for figures.
Light and dark are both defined through CSS custom properties on `:root`,
`@media (prefers-color-scheme: dark)` and `[data-theme="dark"]`. Never declare a
colour only inside a media query. The two logos are base64 data URIs.

## Domain rules that matter

- **Headline totals come from the BMV deck, July 2026, slide 5**: EGP 103Mn total
  investment, EGP 4Mn unpaid, 13 companies. Computed from the actual payment
  rates (30.83, 30.89, 40, 48.62), not from a flat rate. Editable on the Legend tab.
- The flat EGP/USD rate of 50 is used **only** for per row USD equivalents, per
  the original workbook's Legend. Two conventions coexist on purpose.
- The tracker holds 12 of the 13 companies. **Haktiv is absent.** This is
  surfaced on the dashboard and the Legend, not hidden.
- **Never put the words "confidential" or "internal" on the page.** The user has
  asked for this explicitly.
- Seats are roles, not names. The dashboard is identical for every role with one
  exception: **Legal** gets an automatic popup listing open legal requests and
  unseen updates. Do not add other per role differences without being asked.

## Open items

1. Create the remaining five users in Supabase Auth and set `profiles.role` for
   each. Everyone defaults to `Analyst`, so Legal sees no queue until this is done.
2. Verify realtime with two browsers signed in as different people.
3. Optional, not yet requested: lock `invested`, `cap`, `discount` and
   `maturity_date` to Head and Chief Venture Officer. Right now any role can edit
   them and they come from signed agreements.
4. Optional: restrict deleting an update to the seat that posted it.

## Gotchas already paid for

- The Supabase SQL editor runs the whole file in one transaction. Any error rolls
  back everything, including the seed.
- `alter publication supabase_realtime add table` errors if the table is already a
  member. The script guards this; keep the guard.
- There used to be a `history_dedupe` unique index on
  `(entry_date, company, md5(entry))` to make the history seed re-runnable. It
  was dropped: in daily use it blocked two similar entries on the same day and
  blocked editing an entry into wording another already had. The seed now
  guards itself with `where not exists (select 1 from public.history)`, and
  **Undo** is the safeguard against accidental duplicates. Do not reintroduce it.
- In its place `addHistory()` warns before adding a **near** duplicate: word
  overlap of 0.8 or more against an entry with the same company and date
  (`similarity()`). It is a confirm, not a block — the situation box adds rather
  than edits, so rewording an entry through it posts a second nearly identical
  one, which is how Flend came to be logged three times. Pass `{force:true}` to
  skip the check, as ticking an action does.
- **Every write records its inverse** on a 20-deep undo stack (`pushUndo`).
  Inserts carry a client-generated `uid()` rather than a Postgres default, so
  undoing an insert can address the row and undoing a delete restores the same
  id. `undoing` suppresses stacking during an undo, so the stack drains.
- The Excel export writes the `.xlsx` by hand (`buildXlsx`): an xlsx is a ZIP of
  XML parts, and entries are stored **uncompressed**, so it needs only a CRC32
  and no library. SheetJS was not used because its free build cannot write cell
  styling at all, and the point of the export is the formatting. Two rules the
  file format is unforgiving about: the child elements of `<worksheet>` must
  appear in schema order (`sheetViews`, `sheetFormatPr`, `cols`, `sheetData`,
  `autoFilter`, `mergeCells`, `pageSetup`), and a single control character in
  any cell makes Excel reject the whole workbook — `xesc()` strips them.
- The export is a boardroom-readable snapshot, not a mirror of the operational
  tracker: `XL_TRACKER_COLS` drops the contract-detail columns (instrument,
  bucket, ccy, invested, cap, discount, the trigger/maturity dates) — those
  live in the app, not the sheet a reviewer forwards. It also drops `#`: the
  sheet is sorted by priority (`exportXlsx` sorts rows by `PRI_ORDER` before
  building), so a row number that no longer counts up just reads as noise.
  Company leads, then Priority, then `issue_title`, a genuine stored one-liner
  ("Title of Ongoing Issue") edited from "Edit status & action" alongside
  Strategic Target — not derived from the situation text, since there is no
  reliable way to summarise arbitrary free text into a one-liner without an
  LLM in the loop, and this app has none client-side. Last Updated is left
  unbanded. The subtitle omits "Confidential — Internal", per the domain rule
  above.
- **The `closure` column is labelled "Strategic Target"**, in the app and in
  the export header. The column, the `CO_COLS` key and the seed all still say
  `closure`; only the words the team reads changed. Do not rename the column
  to match — it buys nothing and touches every read site.
- Each entry in `XL_TRACKER_BANDS` carries **`p:`, an explicit index into
  `XL_BANDS`**, rather than taking its colour from its position. Positional
  colours broke the moment the band list got shorter: LEGAL is meant to be a
  bright red `#C00000` so it stands out, and as the fifth of seven bands it
  got that for free — as the third of five it silently became maroon. `at:`
  indexes into `XL_TRACKER_COLS`, where index 0 is `#`, which stays unbanded.
- Dates are written as Excel serials (`xlDate`, days since 1899-12-30).
- The row detail panel gets its width set in JavaScript (`fitDetail`) because the
  table is wider than the viewport and the panel lives in a sticky cell.

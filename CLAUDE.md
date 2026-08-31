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
| `middleware.ts` | Soft link-share gate (see Architecture). The one non-static piece |
| `404.html` | Shown to anyone the middleware gate blocks |
| `package.json`, `package-lock.json` | Only exist for `middleware.ts`'s `@vercel/functions` dependency |

## Data model

Tables: `companies` (12 rows), `history` (58 rows), `messages`, `settings`
(key/jsonb), `profiles` (one per auth user, carries `role`).

JavaScript uses camelCase, Postgres uses snake_case. The mapping lives in the
`CO_COLS` object; `rowToCo()` and `patchToRow()` translate. Add a column in three
places: the SQL, `CO_COLS`, and wherever it renders.

`settings` keys: `lists`, `fx`, `asOf`, `dashNote`, `sources`, `reading`,
`triggerMap`, `investments`.

## Code conventions

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
5. Belmazad has no recorded first drawdown date, so its maturity is an assumption.

## Gotchas already paid for

- The Supabase SQL editor runs the whole file in one transaction. Any error rolls
  back everything, including the seed.
- `alter publication supabase_realtime add table` errors if the table is already a
  member. The script guards this; keep the guard.
- The Excel export writes the `.xlsx` by hand (`buildXlsx`): an xlsx is a ZIP of
  XML parts, and entries are stored **uncompressed**, so it needs only a CRC32
  and no library. SheetJS was not used because its free build cannot write cell
  styling at all, and the point of the export is the formatting. Two rules the
  file format is unforgiving about: the child elements of `<worksheet>` must
  appear in schema order (`sheetViews`, `sheetFormatPr`, `cols`, `sheetData`,
  `autoFilter`, `mergeCells`, `pageSetup`), and a single control character in
  any cell makes Excel reject the whole workbook — `xesc()` strips them.
- The export's columns, widths and group bands deliberately mirror
  `Portfolio_Dashboard_v4.xlsx` — verified by diffing a generated file against it.
  Two deliberate departures: bands use the app's maroon identity rather than the
  workbook's navy (with LEGAL a bright red, `#C00000`, so it stands out), and the
  subtitle omits the workbook's "Confidential — Internal", per the domain rule
  above.
- Dates are written as Excel serials (`xlDate`, days since 1899-12-30). Invested
  and Cap use `#,##0` and **not** the workbook's `$#,##0`, because the tracker
  holds EGP positions too and the currency lives in its own `Ccy` column.
- The row detail panel gets its width set in JavaScript (`fitDetail`) because the
  table is wider than the viewport and the panel lives in a sticky cell.

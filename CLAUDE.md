# Stride — project conventions

Single-user athletic weight-loss PWA. Static frontend + Supabase (Postgres + RLS)
+ Deno Edge Functions. Deployed via GitHub Pages (silkham/Fitnesstracker →
https://silkham.github.io/Fitnesstracker/). NO build step — `git push` deploys.

## Architecture (most important)
- The frontend is now THREE files: `index.html` (markup only, ~230 lines),
  `styles.css` (the design system), and `app.js` (the ~4,700-line application logic,
  loaded as a PLAIN classic `<script src="app.js">` after the Supabase CDN script).
  The base CSS/JS extraction is DONE (v4.4). `app.js` is still one big global-scope
  script — the next direction is splitting it by concern, NOT re-inlining anything.
- **Do NOT add logic back into `index.html`.** New JS goes in `app.js` (or a new
  file); new CSS goes in `styles.css`. Target end state: where a concern is genuinely
  self-contained + DOM-free, break it into ES modules by concern.
- **THE ONCLICK LANDMINE (still live — read before splitting app.js):** there are ~157
  `onclick="fnName(...)"` bindings — in static markup AND inside template-string
  render functions. Classic `<script>` makes those functions global, so they work.
  If you convert JS to `<script type="module">`, module scope hides them and EVERY
  handler silently breaks. When moving a function that any `onclick` calls, either
  keep it a classic global script, expose it on `window`, or migrate the call site
  to `addEventListener`. There is no test net to catch this — verify by hand.
  Verify by grepping every `onclick=`/`on*=` target and confirming each still maps
  to a top-level global in `app.js` (that's how v4.4 was checked).
- `app.js` stays a PLAIN classic global script for now (zero handler risk). Only
  peel a concern into an ES module once it's genuinely DOM-free and no `onclick`
  reaches it. Treat ES-modules-by-concern as a direction, not a mandate.

## Security (already correct — keep it)
- Supabase anon key is public by design; data protected by Row Level Security.
- Auth uses the user's own Supabase JWT. No secrets in the frontend.
- Edge Function secrets live in Supabase env vars, never in git.

## Workflow
- `main` stays deployable. Branch for exploratory/risky work.
- One concern per commit. Never leave TEMP/probe/debug code in `main`.
- Commit message style: `<version>: <summary>` e.g. `4.3: Programs → data-driven`.
- Bump `APP_VERSION` each user-facing deploy — it shows on the You page. It now
  lives in `app.js` (near the top, after the `State` object), NOT in index.html.

## Testing (no Node/npm/deno on this machine)
- Pure logic should have tests. Run them with JavaScriptCore:
  `/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc`
- Syntax-check JS: `jsc -e "new Function(readFile('app.js'))"`. jsc proves JS RUNS,
  not that it LOOKS right — it can't catch CSS/visual bugs.
- **Live browser preview is environmentally blocked for this project.** The preview
  server process is sandboxed out of the project directory (every file 404s; even a
  custom no-`getcwd` server can't read the tree). Don't burn time trying to launch it —
  verify with jsc parse + pure-logic unit tests + the onclick-handler grep, and flag a
  manual click-through on the live URL as the visual safety net after deploy.

## Supabase (project ref: dgbbyijhabjozqrkokrq)
- Deploy a function: `supabase functions deploy <name> --project-ref dgbbyijhabjozqrkokrq`
  (CLI is system-wide, logged in account-wide; Docker not needed).
- Run SQL: `supabase db query --linked -f <file>.sql` (after `supabase link --project-ref ...`).
  This runs as postgres (bypasses RLS) — the way to verify user-owned rows
  (e.g. `workouts`) that the anon key can't read.
- Ship schema changes as `supabase-phaseN-*.sql` files. Do NOT auto-run destructive
  SQL (DROP/DELETE) — hand it to the user to run, after showing it.
- The peloton-ingest INGEST_SECRET is recoverable from `cron.job` (job
  `peloton-ingest-4h`) via db query — use it as the Bearer to drive the function
  from the CLI (e.g. the catalog branch).

## In-app program import (v4.9 direction — supersedes manual onboarding for new programs)
- `peloton-ingest` has two PeloBuddy branches (deployed 2026-07-02): `{programIndex:true}`
  scrapes pelobuddy.com/programs/ (~174 programs) into `program_index`;
  `{importProgram:{url}, commit?, program_id?}` parses a program article's classId
  links (+ best-effort Week/Day headings) and falls through to the catalog branch.
  Both dry-run by default; `commit:true` writes. program_id defaults to the article slug.
- **PeloBuddy is Cloudflare-JS-challenge-walled for local curl (even with full browser
  headers) but serves real HTML to a plain Deno fetch with a browser UA from Supabase
  egress IPs.** Probe/import from the edge, not from this machine.
- Import copies the article og:image into the public `program-art` storage bucket and
  sets `programs.image_url` (absolute URL). Import never nulls out curated artwork
  (image_url only included in the upsert when art was fetched).
- The function accepts EITHER the INGEST_SECRET or any valid Supabase user JWT
  (verified via /auth/v1/user) — the app can trigger import without shipping secrets.
- Phase 8 schema (applied 2026-07-02): `program_index` (RLS off, shared catalog),
  `user_programs` (per-user, RLS auth.uid(), user_id defaults to auth.uid()),
  `program-art` bucket. programs/program_classes stay RLS-off shared catalog;
  "my programs" = user_programs join. Multi-user caveat: peloton-ingest sync is
  still hard-wired to ONE Peloton account — a second user's ticking needs per-user
  ingest work.

## Program onboarding (proven pipeline — no OCR, no Peloton program API)
- Source: PeloBuddy article for the program (index: pelobuddy.com/programs/).
  Every class links to `members.onepeloton.com/...&classId=<32-hex>` where
  classId = `peloton_ride_id`. Article HTML is bot-walled for curl — fetch via
  WebFetch; wp-content images DO fetch with a browser UA.
- Flow: build `{catalog:true, classes:[{n,title,instructor,ride_id,week,day}],
  program_id, program_title, program_subtitle}` → dry-run (`commit:false`,
  expect all "explicit") → `commit:true`. Writes peloton_classes (deduped;
  real discipline) + programs/program_classes (with week/day).
- Artwork: crop to landscape (`sips -c <h> <w> --cropOffset <y> <x>`), commit as
  `img/programs/<id>.jpg`, set `programs.image_url` (repo-relative path). Hero
  fallback chain: programs.image_url → first class ride still → instructor
  photo → gradient. Official art renders as an <img> at natural size with NO
  title overlay (the art carries the title) — don't reintroduce the overlay.
- PeloBuddy articles can be STALE vs the current in-app program (Peloton swaps
  re-aired classes/instructors). The app is ground truth: if a completed class
  doesn't tick, re-verify that ride_id via the app's Share → Copy Link.
- `program_classes.week/day` nullable — app groups by them when present
  (multi-class days share a "Day N"), else falls back to 5-per-week slices.

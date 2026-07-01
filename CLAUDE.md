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
- Bump `APP_VERSION` (in index.html) each user-facing deploy — it shows on the You page.

## Testing (no Node/npm/deno on this machine)
- Pure logic should have tests. Run them with JavaScriptCore:
  `/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc`
- Syntax-check inline JS: python-extract the non-src `<script>` blocks to a temp .js,
  then `jsc -e "new Function(readFile('/tmp/x.js'))"`. jsc proves JS RUNS, not that it
  LOOKS right — it can't catch CSS/visual bugs.

## Supabase (project ref: dgbbyijhabjozqrkokrq)
- Deploy a function: `supabase functions deploy <name> --project-ref dgbbyijhabjozqrkokrq`
  (CLI is system-wide, logged in account-wide; Docker not needed).
- Run SQL: `supabase db query --linked -f <file>.sql` (after `supabase link --project-ref ...`).
- Ship schema changes as `supabase-phaseN-*.sql` files. Do NOT auto-run destructive
  SQL (DROP/DELETE) — hand it to the user to run, after showing it.

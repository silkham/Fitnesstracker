# Stride — project conventions

Single-user athletic weight-loss PWA. Static frontend + Supabase (Postgres + RLS)
+ Deno Edge Functions. Deployed via GitHub Pages (silkham/Fitnesstracker →
https://silkham.github.io/Fitnesstracker/). NO build step — `git push` deploys.

## Architecture (most important)
- The frontend is ONE legacy `index.html` (~6,300 lines: CSS + HTML + ~4,700 lines
  inline JS). This is being unwound. The split is NOT done yet — be honest about that.
- **Do NOT add new logic to the inline `<script>`.** Move code OUT of index.html as
  you touch it: JS → its own file, CSS → its own file. Target end state:
  `index.html` is markup only, styles in `styles.css`, logic in `app.js` (and, only
  where a concern is genuinely self-contained + DOM-free, ES modules by concern).
- **THE ONCLICK LANDMINE (read before any JS move):** there are ~157
  `onclick="fnName(...)"` bindings — in static markup AND inside template-string
  render functions. Classic `<script>` makes those functions global, so they work.
  If you convert JS to `<script type="module">`, module scope hides them and EVERY
  handler silently breaks. When moving a function that any `onclick` calls, either
  keep it a classic global script, expose it on `window`, or migrate the call site
  to `addEventListener`. There is no test net to catch this — verify by hand.
- Prefer extracting to a PLAIN classic `app.js` first (keeps global scope, zero
  handler risk). Treat ES-modules-by-concern as a direction, not a mandate.

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

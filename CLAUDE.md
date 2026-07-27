---
project: Stride
status: active
last_updated: 2026-07-14
next_milestone: None recorded — set next milestone here
repo: https://github.com/silkham/Fitnesstracker
live_url: https://silkham.github.io/Fitnesstracker/
---

# Stride — project conventions

<!-- The Status and Roadmap sections below are read by the Project Dashboard.
     Keep them current: Status = where it is now, Roadmap = what's planned.
     Changelog is pulled live from git commit history, so don't maintain one here. -->

## Status
Live and shipping. Single-user athletic weight-loss PWA on Supabase + Deno Edge
Functions, deployed via GitHub Pages (`git push` deploys). Most recent shipped work:
in-app program import (v4.9), add-a-program preview + filters (v4.10), instructor tab
with realtime rendering (v4.11), meal photo logging (v4.12), and the LifeOS hub
adapter (v4.13). Program onboarding runs on a proven no-OCR pipeline.

## Roadmap
- [ ] None recorded yet — add planned milestones here for the dashboard to show

Single-user athletic weight-loss PWA. Static frontend + Supabase (Postgres + RLS)
+ Deno Edge Functions. Deployed via GitHub Pages (silkham/Fitnesstracker →
https://silkham.github.io/Fitnesstracker/). NO build step — `git push` deploys.

- **`.nojekyll` is required** (repo root). Pages is `build_type: legacy` (Jekyll);
  without `.nojekyll` it ran the site through Jekyll and builds failed
  intermittently ("Page build failed"), stranding the live site on the last good
  build while `git push` looked successful. If a push doesn't go live, check
  `gh api repos/silkham/Fitnesstracker/pages/builds/latest` for status/errored —
  don't assume it's a browser cache.

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
- **Catalog tables are RLS-locked (fix applied 2026-07-07):** `peloton_classes`,
  `program_classes`, `program_index`, `programs` now have RLS ON with a read-only
  SELECT policy for anon/authenticated; anon INSERT/UPDATE/DELETE/TRUNCATE grants
  were REVOKED. The frontend (anon key) only READS these — verified; all catalog
  WRITES go through `peloton-ingest`, which uses `SUPABASE_SERVICE_ROLE_KEY`
  (bypasses RLS). **Tell:** if class lists stop loading or sync starts failing,
  something is trying to WRITE via the anon key — fix the writer to use
  service_role, don't loosen the RLS.

## Workflow
- `main` stays deployable. Branch for exploratory/risky work.
- One concern per commit. Never leave TEMP/probe/debug code in `main`.
- Commit message style: `<version>: <summary>` e.g. `4.3: Programs → data-driven`.
- Bump `APP_VERSION` each user-facing deploy — it shows on the You page. It now
  lives in `app.js` (near the top, after the `State` object), NOT in index.html.
- **CACHE-BUST LANDMINE — bump the `?v=` on EVERY asset tag in `index.html` in the
  SAME commit as `APP_VERSION`.** `index.html` loads `styles.css?v=<ver>`,
  `app.js?v=<ver>`, `lifeos.js?v=<ver>`. GitHub Pages serves these `max-age=600`,
  so an unchanged `?v` means devices keep the stale copy and your deploy silently
  doesn't land. (v4.14.0/v4.14.1 shipped with a stale `?v` this way.) The version
  string in the commit SUBJECT is unreliable — trust `APP_VERSION` and the `?v`s.

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

## In-app program import (SHIPPED v4.9, user-verified — supersedes manual onboarding)
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
- Two legacy programs have ids ≠ their index slugs — `PROGRAM_SLUG_ALIASES` in
  app.js maps them (discover-your-power, stronger-you). New imports use id=slug;
  keep that convention so no more aliases are ever needed.

## Add-a-program preview + filters (SHIPPED v4.10)
- Phase 9 schema (applied 2026-07-02): `program_index` gained nullable
  `description, class_count, weeks, discipline, instructor, level, language,
  enriched_at`. Non-destructive ADD COLUMNs (`supabase-phase9-*.sql`).
- New branch `{enrichIndex:true, commit?, limit?(≤60,def20), slugs?, reenrich?}`
  backfills those columns per row: description=og:description, class_count=classId
  slots, weeks=max Week heading (else count/5). discipline/instructor/level/language
  are parsed from the CURATED TITLE (titleDiscipline/titleInstructors/titleLevel/
  titleLanguage helpers); title-ambiguous discipline ("other") falls back to ONE
  ride-details call → normDiscipline. Batched (drive till remainingAfter=0); needs
  Peloton auth so it runs AFTER login. All 174 backfilled, 0 errors. `importProgram`
  commit also PATCHes the row so single adds stay enriched.
- normDiscipline/titleDiscipline set: ride|strength|boxing|row|yoga|stretch|run|
  walk|meditation|other. ~62 programs have null instructor (brand-named, not
  "with X") — expected; they just don't appear under any instructor filter.
- App (Add screen): rows now TAP → `openProgramPreview` sheet (reuses openSheet;
  shows description/class_count/weeks/level + Add or View+Remove) instead of
  instant-add. Filters: discipline chips (`setProgramAddDiscipline`) + instructor
  `<select>` (`setProgramAddInstructor`), both from the enriched index, ANDed with
  the text search (which also matches instructor). Remove is now reachable from the
  preview sheet too (`removeUserProgram(pid, true)` stays on the Add screen).

## Instructor tab + realtime rendering (SHIPPED v4.11)
- **LANDMINE — realtime workout events are debounced, don't revert.** A Peloton
  sync upserts many `workouts` rows; the realtime handler must call
  `scheduleRealtimeRender()` (200ms debounce), NOT `renderAll()` per row — per-row
  renders caused visible flashing on every focus (autoSyncIfDue on visibilitychange).
- Live instructor schedule is cached in localStorage (`stride_instr_sched_v1`, 6h
  TTL, keyed on a `favsSig()` of the favourites). `ensureInstructorSchedule()` is
  the tab entry point (cache-first; refetch when stale or no future classes);
  `renderInstructor` filters to `start_unix > now`. `saveMemberWorkouts` calls
  `clearScheduleCache()` when favourites change. Manual "Refresh" forces a pull.
- Favourite-instructor editor uses a `<select>` from the cached instructor
  directory (`renderInstructorPicker`/`addEditInstructorFromSelect`) to avoid
  spelling mistakes; falls back to the free-text input only if the directory
  can't load.

## Meal photo logging (SHIPPED v4.12)
- **The Meals tab is now a per-member daily PHOTO FOOD LOG, not the weekly
  planner.** The old planner (`renderMeals` week grid, `openMealEditor`,
  `writeMealSlot`, `week_plans.slots`) is DEAD but left in place; `week_plans`
  data is untouched. Do NOT reintroduce the planner UI. Meals screen = today's
  4 slots (breakfast/lunch/dinner/snack) with a day-nav (`mealDayNav`,
  forward-capped at today), rendered by the rewritten `renderMeals`.
- **AI macro estimate is a CLIENT-SIDE Claude VISION call** — reuses the same
  pattern as recipe `estimateMacros`: `State.settings.claude_api_key` +
  `anthropic-dangerous-direct-browser-access` header, model **`claude-sonnet-5`**.
  `analyzeMeal` sends `{type:'image',source:{base64}}` + prompt, parses the JSON.
  No Edge Function. Works without a key (manual entry); estimate needs it.
- **MODEL LANDMINE (v4.12.6):** this API key can access `claude-sonnet-5` but
  NOT `claude-sonnet-4-20250514` (returns HTTP 404 `not_found_error`) — both
  `analyzeMeal` AND recipe `estimateMacros` now use `claude-sonnet-5`. Do NOT use
  a `claude-sonnet-4*` id. Also do NOT prefill the assistant turn with sonnet-5
  (its default extended thinking rejects prefill → HTTP 400) — instead read ALL
  text blocks (`filter(b=>b.type==='text')`, skips the thinking block) and greedy-
  match the outermost `{...}`. The strong "output ONLY JSON, never ask questions"
  prompt is what forces valid JSON without a prefill.
- **Phase 10 schema** (`supabase-phase10-meal-log.sql`, applied 2026-07-02):
  `meal_logs` (household+member keyed, RLS on the household_memberships pattern,
  `unique(member_id,log_date,slot)`, `state` in logged|skipped), 4 nullable
  `members` target cols (`kcal_target/protein_target_g/carb_target_g/fat_target_g`),
  and a PUBLIC `meal-photos` storage bucket (client uploads, unguessable
  `{member_id}/{date}_{slot}_{ts}.jpg` paths, authenticated-write RLS).
- **Metrics honesty landmine:** a day counts toward averages only if
  `dayComplete()` (all 3 MAIN slots logged-or-skipped). Nutrition card
  (`nutritionCard`, injected into BOTH `renderProgress` paths) averages over
  complete days only — don't average raw days or half-logged days drag the trend
  down. "Skipped" is a real state (ate nothing) distinct from unlogged.
- Catch-up: `missedSlots()` = past-due unlogged main slots over `MEAL_CATCHUP_DAYS`
  (3). Surfaced as `mealNudgeCard` on Today + `openMealCatchup` sheet. `mealTodayCard`
  = Today's calories/protein summary. Photo upload is best-effort (feature works if
  the bucket is missing — row just saves photo-less). Realtime `meal_logs` events
  use `scheduleRealtimeRender()` (same debounce landmine as workouts).

## LifeOS hub adapter (SHIPPED v4.13.0)
- **`lifeos.js`** (repo root) publishes Stride's signals into the shared
  `lifeos.signals` contract — the cross-app hub reads them read-only. It is a
  **classic global `<script>` loaded AFTER `app.js`** in `index.html` (shares
  app.js's global scope: reads `State`, `activeMember`, `dayTotals`, `missedSlots`,
  `todayISO`, `isoDateAddDays`). Adds NO DOM/onclick — clear of the onclick landmine.
- Entry point `publishToLifeOS()` is called **fire-and-forget at the end of
  `loadAll()`** (wrapped in try/catch — never blocks or breaks boot). Best-effort:
  no-ops if the `lifeos` schema isn't reachable.
- Write path is the SAME client/JWT/household — no second Supabase client:
  `State.client.schema('lifeos').from('signals').upsert(rows, {onConflict:
  'household_id,app,key'})`. `lifeos` schema lives in the SAME project
  (`dgbbyijhabjozqrkokrq`) and is already PostgREST-exposed.
- **Emits 4 signals** (app=`strive`), stable keys, re-published every boot:
  `weight` (metric: latest kg + signed weekly trend), `calories-today` (metric:
  today's kcal vs `members.kcal_target`), `log-food-today` (task, due today),
  `workout-tomorrow` (nudge, due tomorrow). Tasks/nudges **flip `status`
  open↔done each boot** so the hub always mirrors reality — Stride is the source
  of truth, no manual dismiss.
- **Trend colour is via the `state` column** (`good|warn|bad`), NOT the trend sign
  — LifeOS colours by `state`. Losing weight / under calorie budget = `good`;
  over budget = `bad`. When adding more metrics, always set `state` explicitly.
- No new schema in THIS repo — `lifeos.signals` is owned/migrated by the LifeOS
  repo. Verify logic with the jsc harness pattern (browser preview is env-blocked
  here); a real upsert only happens when a signed-in user opens the app.

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

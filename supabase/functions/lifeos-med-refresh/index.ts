// ============================================================================
//  lifeos-med-refresh — server-side refresh of Stride's `med` LifeOS signal.
//
//  WHY THIS EXISTS. Every other Stride signal is published client-side, on
//  app-open. That is correct for things that only change when you act in the
//  app. It is NOT correct for a once-daily medication: the DAY ROLLS OVER while
//  the app is closed. `lifeosMedSignal` flips status to 'done' once a day is
//  acted on, and LifeOS only renders open tasks — so the morning after a logged
//  dose, the hub showed NO medication prompt at all until Stride was opened.
//  Same class of problem the Investing app solved with its hourly cron.
//
//  Runs hourly from pg_cron (job `lifeos-med-refresh-hourly`, scheduled by
//  supabase-phase12-lifeos-med-cron.sql). Reads members + med_log with the
//  service-role key, so it always holds COMPLETE, authoritative state — it can
//  never publish the partial snapshot the republish-overwrite landmine warns
//  about.
//
//  It RECORDS and REMINDS. It makes no dosing decision and gives no advice.
//
//  Secrets used (all already set): INGEST_SECRET, SUPABASE_URL,
//  SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, HOUSEHOLD_ID, MEMBER_ID,
//  LOCAL_TZ.
// ============================================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-ingest-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const APP = "strive";
const KEY = "med";
const CTA = "https://silkham.github.io/Fitnesstracker/";
const WINDOW_MIN = 30;   // keep in step with MED_WINDOW_MIN in app.js

// Local calendar date / clock time in the household's timezone. The cron fires
// in UTC, so deriving "today" from UTC would roll the day over at the wrong
// moment (and BST would shift it again).
const localDate = (tz: string, d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);

const localTime = (tz: string, d: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);

const fmtDoseMg = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return (Number.isInteger(n) ? String(n) : String(+n.toFixed(2))) + " mg";
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "lifeos-med-refresh" });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  // Same auth shape as peloton-ingest: the shared INGEST_SECRET (cron/curl) or
  // any valid logged-in Supabase user JWT.
  const SECRET = Deno.env.get("INGEST_SECRET") ?? "";
  const authHeader = req.headers.get("authorization") ?? req.headers.get("x-ingest-secret") ?? "";
  let authorized = !!SECRET && authHeader.includes(SECRET);
  if (!authorized && authHeader.startsWith("Bearer ")) {
    try {
      const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { Authorization: authHeader, apikey: ANON_KEY },
      });
      authorized = u.ok;
    } catch { /* fall through */ }
  }
  if (!authorized) return json({ error: "unauthorized" }, 401);

  const HOUSEHOLD_ID = Deno.env.get("HOUSEHOLD_ID")!;
  const PREFERRED_MEMBER = Deno.env.get("MEMBER_ID") ?? "";
  const TZ = Deno.env.get("LOCAL_TZ") || "UTC";

  const H = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const dryRun = body?.dryRun === true;

  const today = localDate(TZ);

  // ---- 1. who is on a medication? -----------------------------------------
  const mRes = await fetch(
    `${SUPABASE_URL}/rest/v1/members?household_id=eq.${HOUSEHOLD_ID}` +
    `&select=id,display_name,med_name,med_current_dose_mg&order=slot`,
    { headers: H },
  );
  if (!mRes.ok) return json({ error: "members read failed", detail: await mRes.text() }, 502);
  const members = await mRes.json() as Array<Record<string, any>>;
  const medicated = members.filter((m) => m.med_name);

  // Nobody on a medication → make sure no stale row lingers in the hub.
  if (!medicated.length) {
    if (!dryRun) await dismiss(SUPABASE_URL, H, HOUSEHOLD_ID);
    return json({ ok: true, today, tz: TZ, action: "dismissed", reason: "no member has med_name set" });
  }

  // Single-user app: prefer the canonical MEMBER_ID, else the first medicated.
  const member = medicated.find((m) => m.id === PREFERRED_MEMBER) ?? medicated[0];

  // ---- 2. has today been acted on? ----------------------------------------
  const lRes = await fetch(
    `${SUPABASE_URL}/rest/v1/med_log?member_id=eq.${member.id}&log_date=eq.${today}` +
    `&select=dose_state,dose_mg,taken_at`,
    { headers: H },
  );
  if (!lRes.ok) return json({ error: "med_log read failed", detail: await lRes.text() }, 502);
  const logs = await lRes.json() as Array<Record<string, any>>;
  const log = logs[0] ?? null;
  const st: string | null = log?.dose_state ?? null;

  // ---- 3. build the signal — same shape as lifeosMedSignal in lifeos.js ----
  const takenMs = log?.taken_at ? new Date(log.taken_at).getTime() : NaN;
  const remaining = (st === "taken" && Number.isFinite(takenMs))
    ? Math.max(0, takenMs + WINDOW_MIN * 60000 - Date.now())
    : 0;
  const windowOpen = remaining > 0;
  const dose = fmtDoseMg(member.med_current_dose_mg);

  let title: string, detail: string;
  if (windowOpen) {
    title = `${member.med_name} taken — water only`;
    detail = `Nothing to eat or drink until ${localTime(TZ, new Date(takenMs + WINDOW_MIN * 60000))}`;
  } else if (st === "taken") {
    title = `${member.med_name} logged`;
    detail = Number.isFinite(takenMs) ? `Taken ${localTime(TZ, new Date(takenMs))}` : "Taken";
  } else if (st === "skipped") {
    title = `${member.med_name} logged`; detail = "Skipped today";
  } else if (st === "missed") {
    title = `${member.med_name} logged`; detail = "Missed — do not double up";
  } else {
    title = `Take ${member.med_name}${dose ? ` · ${dose}` : ""}`;
    detail = "Fasted, small sip of plain water only";
  }

  const row = {
    household_id: HOUSEHOLD_ID, app: APP, key: KEY, kind: "task",
    title, detail,
    value: null, unit: null, trend: null,
    state: (st === "taken" && !windowOpen) ? "good" : "warn",
    due: today, cta_url: CTA,
    cta_label: windowOpen ? "Open Stride" : "Log dose",
    sort_order: 5,
    status: (st && !windowOpen) ? "done" : "open",
    updated_at: new Date().toISOString(),
  };

  if (dryRun) return json({ ok: true, dryRun: true, today, tz: TZ, member: member.display_name, row });

  // ---- 4. upsert into lifeos.signals (Content-Profile targets the schema) --
  const wRes = await fetch(
    `${SUPABASE_URL}/rest/v1/signals?on_conflict=household_id,app,key`,
    {
      method: "POST",
      headers: {
        ...H,
        "Content-Profile": "lifeos",
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify([row]),
    },
  );
  if (!wRes.ok) return json({ error: "signal upsert failed", detail: await wRes.text() }, 502);

  return json({ ok: true, today, tz: TZ, member: member.display_name, status: row.status, title: row.title });
});

// Medication switched off → dismiss the row rather than leave a stale prompt.
// Update-in-place (not upsert) so we never insert a row that shouldn't exist.
async function dismiss(url: string, H: Record<string, string>, hid: string) {
  await fetch(
    `${url}/rest/v1/signals?household_id=eq.${hid}&app=eq.${APP}&key=eq.${KEY}`,
    {
      method: "PATCH",
      headers: { ...H, "Content-Profile": "lifeos" },
      body: JSON.stringify({ status: "dismissed" }),
    },
  );
}

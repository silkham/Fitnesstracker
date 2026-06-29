// ============================================================
// peloton-ingest — pulls PLANNED (reservations) + COMPLETED (workouts +
// performance_graph) straight from the Peloton API into the Fitness DB.
// One-way Peloton → Stride. Peloton is the source of truth for Peloton
// workouts; planned is a PURE MIRROR of current reservations (cancel/move
// in Peloton ⇒ it moves/disappears here).
//
// Secrets: INGEST_SECRET, MEMBER_ID, HOUSEHOLD_ID, PELOTON_EMAIL,
//          PELOTON_PASSWORD, optional LOCAL_TZ (IANA, e.g. Australia/Melbourne).
//          (SUPABASE_URL + SERVICE key auto.)
// Turn OFF "Verify JWT" for this function.
//
// Auth: Auth0 Universal Login + PKCE (ported from the validated p2g v6 flow).
// On each run we try the stored refresh_token first, then fall back to a full
// password login; the (possibly rotated) refresh token is persisted to
// integration_tokens so steady-state runs skip the full login.
// ============================================================

// Browser button POSTs cross-origin from GitHub Pages → needs CORS + preflight.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-ingest-secret",
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---- Peloton / Auth0 constants (validated) -----------------
const AUTH_DOMAIN = "auth.onepeloton.com";
const CLIENT_ID = "WVoJxVDdPoFx4RNewvvg6ch2mZ7bwnsM";
const AUDIENCE = "https://api.onepeloton.com/";
const SCOPE = "offline_access openid peloton-api.members:default";
const REDIRECT_URI = "https://members.onepeloton.com/callback";
const AUTH0_CLIENT = "eyJuYW1lIjoiYXV0aDAuanMtdWxwIiwidmVyc2lvbiI6IjkuMTQuMyJ9";
const API_URL = "https://api.onepeloton.com/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0";

// ---- PKCE helpers ------------------------------------------
function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randStr(n: number): string {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return b64url(buf).slice(0, n);
}
async function sha256b64url(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return b64url(digest);
}

// ---- tiny cookie jar + manual-redirect fetch ---------------
type Jar = Map<string, string>;
function jarHeader(jar: Jar): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function storeCookies(jar: Jar, resp: Response) {
  // Deno exposes each Set-Cookie separately via getSetCookie()
  const list = (resp.headers as any).getSetCookie?.() ?? [];
  for (const sc of list) {
    const first = sc.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}
function absUrl(loc: string, base: string): string {
  try { return new URL(loc, base).toString(); }
  catch { return loc.startsWith("http") ? loc : `https://${AUTH_DOMAIN}${loc.startsWith("/") ? "" : "/"}${loc}`; }
}

interface Req { method?: string; jsonBody?: unknown; form?: Record<string, string>; headers?: Record<string, string>; follow?: boolean; }
interface Res { status: number; headers: Headers; body: string; url: string; }

async function http(jar: Jar, url: string, opts: Req = {}): Promise<Res> {
  let current = url;
  let method = opts.method ?? (opts.jsonBody != null || opts.form != null ? "POST" : "GET");
  let body: string | undefined;
  const headers: Record<string, string> = { "User-Agent": UA, Accept: "*/*", ...(opts.headers ?? {}) };
  if (opts.jsonBody != null) { body = JSON.stringify(opts.jsonBody); headers["Content-Type"] = "application/json"; }
  else if (opts.form != null) { body = new URLSearchParams(opts.form).toString(); headers["Content-Type"] = "application/x-www-form-urlencoded"; }

  const maxHops = opts.follow ? 10 : 0;
  for (let hop = 0; ; hop++) {
    const resp = await fetch(current, {
      method, body, redirect: "manual",
      headers: { ...headers, Cookie: jarHeader(jar) },
    });
    storeCookies(jar, resp);
    const loc = resp.headers.get("location");
    if (hop < maxHops && resp.status >= 300 && resp.status < 400 && loc) {
      current = absUrl(loc, current);
      // 302/303 → follow as GET, drop body; 307/308 keep method+body
      if (resp.status !== 307 && resp.status !== 308) { method = "GET"; body = undefined; delete headers["Content-Type"]; }
      await resp.body?.cancel();
      continue;
    }
    return { status: resp.status, headers: resp.headers, body: await resp.text(), url: current };
  }
}

function parseHiddenForm(body: string): { action: string | null; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const formMatch = body.match(/<form[^>]*action=["']([^"']*)["']/i);
  const action = formMatch ? formMatch[1] : null;
  const inputRe = /<input[^>]*type=["']hidden["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(body))) {
    const tag = m[0];
    const name = tag.match(/name=["']([^"']*)["']/i)?.[1];
    if (!name) continue;
    let val = tag.match(/value=["']([^"']*)["']/i)?.[1] ?? "";
    val = val.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
    fields[name] = val;
  }
  return { action, fields };
}

// ---- full Auth0 PKCE password login ------------------------
async function passwordLogin(email: string, password: string): Promise<{ access: string; refresh: string | null; expires: number }> {
  const jar: Jar = new Map();
  const verifier = randStr(64);
  const challenge = await sha256b64url(verifier);
  let state = randStr(32);
  const nonce = randStr(32);

  // STEP 1: GET /authorize (follow redirects to the hosted login page)
  const authorizeUrl = `https://${AUTH_DOMAIN}/authorize?` + new URLSearchParams({
    client_id: CLIENT_ID, audience: AUDIENCE, scope: SCOPE,
    response_type: "code", response_mode: "query", redirect_uri: REDIRECT_URI,
    state, nonce, code_challenge: challenge, code_challenge_method: "S256", auth0Client: AUTH0_CLIENT,
  }).toString();
  const s1 = await http(jar, authorizeUrl, { follow: true });
  const loginUrl = s1.url;
  const qsState = new URL(loginUrl).searchParams.get("state");
  if (qsState) state = qsState;
  if (!jar.has("_csrf")) throw new Error(`no _csrf cookie after /authorize (status ${s1.status})`);

  // STEP 2: POST /usernamepassword/login (no auto-redirect; returns hidden form)
  const s2 = await http(jar, `https://${AUTH_DOMAIN}/usernamepassword/login`, {
    jsonBody: {
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, tenant: "peloton-prod",
      response_type: "code", scope: SCOPE, audience: AUDIENCE, _csrf: jar.get("_csrf"),
      state, _intstate: "deprecated", nonce,
      username: email, password, connection: "pelo-user-password",
      code_challenge: challenge, code_challenge_method: "S256",
    },
    headers: { Origin: `https://${AUTH_DOMAIN}`, Referer: loginUrl, "Auth0-Client": AUTH0_CLIENT },
    follow: false,
  });
  if (s2.status === 401 || s2.status === 403 || s2.status === 400)
    throw new Error(`login rejected (${s2.status}): ${s2.body.slice(0, 200)}`);

  // STEP 2b: POST the hidden form → follow redirects to the callback
  let landed: string;
  const loc2 = s2.headers.get("location");
  if (loc2) {
    landed = (await http(jar, absUrl(loc2, s2.url), { follow: true })).url;
  } else {
    const fp = parseHiddenForm(s2.body);
    if (!fp.action) throw new Error(`no hidden form after login: ${s2.body.slice(0, 200)}`);
    const s2b = await http(jar, absUrl(fp.action, s2.url), {
      form: fp.fields, headers: { Accept: "text/html,application/xhtml+xml" }, follow: true,
    });
    landed = s2b.url;
  }

  // STEP 3: extract authorization code
  let code = new URL(landed).searchParams.get("code");
  if (!code) throw new Error(`no auth code; landed=${landed.slice(0, 120)}`);

  // STEP 4: exchange code for tokens
  const tok = await tokenExchange({ grant_type: "authorization_code", client_id: CLIENT_ID, code_verifier: verifier, code, redirect_uri: REDIRECT_URI });
  return tok;
}

async function tokenExchange(payload: Record<string, string>): Promise<{ access: string; refresh: string | null; expires: number }> {
  const r = await fetch(`https://${AUTH_DOMAIN}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify(payload),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`token exchange failed (${r.status}): ${body.slice(0, 200)}`);
  const t = JSON.parse(body);
  if (!t.access_token) throw new Error(`no access_token: ${body.slice(0, 200)}`);
  return { access: t.access_token, refresh: t.refresh_token ?? null, expires: t.expires_in ?? 0 };
}

// ---- Peloton API GET (Bearer) ------------------------------
async function api(access: string, path: string): Promise<any> {
  const r = await fetch(API_URL + path, {
    headers: { Authorization: `Bearer ${access}`, Accept: "application/json", "Peloton-Platform": "web", "User-Agent": UA },
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return await r.json();
}

// ---- mapping helpers ---------------------------------------
function normDiscipline(d: unknown): string {
  const s = String(d ?? "").toLowerCase();
  if (s.includes("cycl") || s.includes("bike")) return "ride";
  if (s.includes("strength") || s.includes("bootcamp")) return "strength";
  if (s.includes("yoga")) return "yoga";
  if (s.includes("stretch") || s.includes("mobility")) return "stretch";
  if (s.includes("run")) return "run";
  if (s.includes("walk") || s.includes("hik")) return "walk";
  if (s.includes("medit")) return "meditation";
  return "other";
}
function localParts(unixSec: number, tz: string): { date: string; time: string } {
  const d = new Date(unixSec * 1000);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) if (part.type !== "literal") p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` };
}
const round = (n: number, dp = 0) => { const f = 10 ** dp; return Math.round(n * f) / f; };
function toKm(value: number, unit: string): number { return /mi/i.test(unit) ? round(value * 1.60934, 2) : round(value, 2); }
function toKph(value: number, unit: string): number { return /mph|mi/i.test(unit) ? round(value * 1.60934, 2) : round(value, 2); }

// Pull the rich metrics out of a performance_graph payload.
function extractMetrics(pg: any): Record<string, any> {
  const out: Record<string, any> = { peloton_raw: { summaries: pg.summaries ?? [], metrics: (pg.metrics ?? []).map((m: any) => ({ slug: m.slug, average_value: m.average_value, max_value: m.max_value, display_unit: m.display_unit })) } };
  const sumBy: Record<string, any> = {};
  for (const s of pg.summaries ?? []) sumBy[s.slug] = s;
  const metBy: Record<string, any> = {};
  for (const m of pg.metrics ?? []) metBy[m.slug] = m;

  if (sumBy.total_output?.value != null) out.total_output_kj = round(+sumBy.total_output.value, 2);
  if (sumBy.calories?.value != null) out.calories = Math.round(+sumBy.calories.value);
  if (sumBy.distance?.value != null) out.distance_km = toKm(+sumBy.distance.value, sumBy.distance.display_unit ?? "km");

  const hr = metBy.heart_rate;
  if (hr) {
    if (hr.average_value != null) out.avg_hr = Math.round(+hr.average_value);
    if (hr.max_value != null) out.max_hr = Math.round(+hr.max_value);
    if (Array.isArray(hr.zones)) out.hr_zones = hr.zones.map((z: any) => ({ slug: z.slug, duration: z.duration }));
  }
  const o = metBy.output;
  if (o) { if (o.average_value != null) out.avg_output_w = Math.round(+o.average_value); if (o.max_value != null) out.max_output_w = Math.round(+o.max_value); }
  const c = metBy.cadence;
  if (c) { if (c.average_value != null) out.avg_cadence = Math.round(+c.average_value); if (c.max_value != null) out.max_cadence = Math.round(+c.max_value); }
  const r = metBy.resistance;
  if (r) { if (r.average_value != null) out.avg_resistance = Math.round(+r.average_value); if (r.max_value != null) out.max_resistance = Math.round(+r.max_value); }
  const sp = metBy.speed;
  if (sp) { const u = sp.display_unit ?? "kph"; if (sp.average_value != null) out.avg_speed_kph = toKph(+sp.average_value, u); if (sp.max_value != null) out.max_speed_kph = toKph(+sp.max_value, u); }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "peloton-ingest" });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  // Authorize via EITHER the shared INGEST_SECRET (cron/curl) OR a valid logged-in
  // Supabase user JWT (so the app can trigger it without shipping any secret).
  const SECRET = Deno.env.get("INGEST_SECRET") ?? "";
  const authHeader = req.headers.get("authorization") ?? req.headers.get("x-ingest-secret") ?? "";
  let authorized = !!SECRET && authHeader.includes(SECRET);
  if (!authorized && authHeader.startsWith("Bearer ")) {
    try {
      const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: authHeader, apikey: ANON_KEY } });
      authorized = u.ok;
    } catch { /* fall through */ }
  }
  if (!authorized) return json({ error: "unauthorized" }, 401);

  // force=true (manual button) re-fetches + refreshes metrics on the recent
  // window even for workouts we already store; auto/cron syncs stay incremental.
  let reqBody: any = {};
  try { reqBody = await req.json(); } catch { /* empty body ok */ }
  const force = reqBody?.force === true;
  const MEMBER_ID = Deno.env.get("MEMBER_ID")!;
  const HOUSEHOLD_ID = Deno.env.get("HOUSEHOLD_ID")!;
  const EMAIL = Deno.env.get("PELOTON_EMAIL") ?? "";
  const PASSWORD = Deno.env.get("PELOTON_PASSWORD") ?? "";
  const TZ = Deno.env.get("LOCAL_TZ") || "UTC";
  if (!EMAIL || !PASSWORD) return json({ error: "missing PELOTON_EMAIL/PASSWORD" }, 500);

  // REST helpers (service role)
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
  const restGet = async (q: string) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: H }); return r.ok ? await r.json() : []; };
  const restWrite = async (method: string, q: string, payload: unknown) => {
    const init: RequestInit = { method, headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" } };
    if (payload != null) init.body = JSON.stringify(payload);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, init);
    return { ok: r.ok, status: r.status, err: r.ok ? null : await r.text() };
  };

  // ---- API-health heartbeat (layer 1) -----------------------
  // Stamp the attempt, capture the prior fail streak, then run the whole sync
  // inside one try so ANY uncaught throw (auth/endpoint death) is recorded.
  const writeHealth = (fields: Record<string, unknown>) =>
    restWrite("POST", `integration_tokens?on_conflict=member_id,provider`,
      [{ household_id: HOUSEHOLD_ID, member_id: MEMBER_ID, provider: "peloton", ...fields }]);
  const tokRows = await restGet(`integration_tokens?member_id=eq.${MEMBER_ID}&provider=eq.peloton&select=refresh_token,fail_count&limit=1`);
  const tok0 = Array.isArray(tokRows) && tokRows[0] ? tokRows[0] : null;
  const storedRefresh = tok0?.refresh_token || null;
  const prevFail = Number(tok0?.fail_count) || 0;
  await writeHealth({ last_attempt_at: new Date().toISOString() });

  try {
  // ---- AUTH: refresh first, else full login -----------------
  let access = "", refresh: string | null = null;
  try {
    if (storedRefresh) {
      const t = await tokenExchange({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: storedRefresh });
      access = t.access; refresh = t.refresh ?? storedRefresh;
    } else {
      const t = await passwordLogin(EMAIL, PASSWORD);
      access = t.access; refresh = t.refresh;
    }
  } catch (_e) {
    // refresh failed/expired → full login fallback
    const t = await passwordLogin(EMAIL, PASSWORD);
    access = t.access; refresh = t.refresh;
  }

  // ---- identify user + persist tokens -----------------------
  const me = await api(access, "api/me");
  const uid = me.id;
  await restWrite("POST", `integration_tokens?on_conflict=member_id,provider`, [{
    household_id: HOUSEHOLD_ID, member_id: MEMBER_ID, provider: "peloton",
    refresh_token: refresh, peloton_user_id: uid, updated_at: new Date().toISOString(),
  }]);

  // ============================================================
  // PASS 1 — COMPLETED workouts (rich metrics, dedup by workout id)
  // ============================================================
  const completed = { inserted: 0, upgraded: 0, refreshed: 0, skipped: 0, errors: 0 };
  const existingWk = await restGet(`workouts?member_id=eq.${MEMBER_ID}&peloton_workout_id=not.is.null&select=peloton_workout_id`);
  const knownWorkoutIds = new Set((Array.isArray(existingWk) ? existingWk : []).map((w: any) => w.peloton_workout_id));

  const wkResp = await api(access, `api/user/${uid}/workouts?limit=25&page=0&joins=ride,ride.instructor&sort_by=-created`);
  for (const w of (wkResp.data ?? [])) {
    if (w.status !== "COMPLETE" && w.status !== "complete") { completed.skipped++; continue; }
    const wid = String(w.id);
    const isKnown = knownWorkoutIds.has(wid);
    if (isKnown && !force) { completed.skipped++; continue; }  // incremental syncs skip known; force refreshes them
    try {
      const ride = w.ride ?? {};
      const startSec = w.start_time ?? w.created_at ?? w.created;
      const { date: planned_for } = localParts(startSec, TZ);
      const duration_min = w.end_time && w.start_time ? Math.max(1, Math.round((w.end_time - w.start_time) / 60)) : (ride.duration ? Math.round(ride.duration / 60) : null);
      const session_type = normDiscipline(w.fitness_discipline ?? ride.fitness_discipline);

      let metrics: Record<string, any> = {};
      try { metrics = extractMetrics(await api(access, `api/workout/${wid}/performance_graph?every_n=60`)); }
      catch (_e) { /* some disciplines have no graph; base fields still land */ }

      const rowBase = {
        peloton_workout_id: wid, peloton_ride_id: ride.id ?? null,
        status: "done", source: "peloton",
        session_type, class_title: ride.title ?? null, instructor: ride.instructor?.name ?? null,
        duration_min, calories: w.calories ?? null,
        ftp: w.ftp_info?.ftp ?? null, leaderboard_rank: w.leaderboard_rank ?? null, leaderboard_total: w.total_leaderboard_users ?? null,
        ...metrics,
      };

      if (isKnown) {
        // force refresh: update metrics in place, leave done_at/planned_for untouched
        const r = await restWrite("PATCH", `workouts?member_id=eq.${MEMBER_ID}&peloton_workout_id=eq.${encodeURIComponent(wid)}`, rowBase);
        r.ok ? completed.refreshed++ : (completed.errors++, console.error("refresh", r.err));
        continue;
      }

      // match an existing PLANNED reservation for the same ride within ±1 day → upgrade in place
      let target: any = null;
      if (ride.id) {
        const cands = await restGet(`workouts?member_id=eq.${MEMBER_ID}&peloton_ride_id=eq.${encodeURIComponent(ride.id)}&status=eq.planned&peloton_workout_id=is.null&select=id,planned_for`);
        for (const c of (Array.isArray(cands) ? cands : [])) {
          const diff = Math.abs((new Date(c.planned_for).getTime() - new Date(planned_for).getTime()) / 86400000);
          if (diff <= 1) { target = c; break; }
        }
      }

      const done_at = new Date().toISOString();
      if (target) {
        const r = await restWrite("PATCH", `workouts?id=eq.${target.id}`, { ...rowBase, planned_for, done_at });
        r.ok ? completed.upgraded++ : (completed.errors++, console.error("upgrade", r.err));
      } else {
        const r = await restWrite("POST", `workouts?on_conflict=member_id,peloton_workout_id`, [{ household_id: HOUSEHOLD_ID, member_id: MEMBER_ID, planned_for, done_at, ...rowBase }]);
        r.ok ? completed.inserted++ : (completed.errors++, console.error("insert", r.err));
      }
      knownWorkoutIds.add(wid);
    } catch (e) { completed.errors++; console.error("completed", wid, String(e)); }
  }

  // ============================================================
  // PASS 2 — PLANNED reservations (pure mirror, dedup by reservation id)
  // ============================================================
  const planned = { upserted: 0, deleted: 0, errors: 0 };
  const seenReservations = new Set<string>();
  const resvResp = await api(access, `api/user/${uid}/reservations?limit=40`);
  for (const it of (resvResp.data ?? [])) {
    const pelotonId = String(it.peloton_id ?? "");
    if (!pelotonId) continue;
    try {
      let p: any;
      try { p = await api(access, `api/peloton/${pelotonId}?joins=ride,ride.instructor`); }
      catch (_e) { p = await api(access, `api/peloton/${pelotonId}`); }
      const pel = p.peloton ?? p;
      const ride = (p.ride && typeof p.ride === "object") ? p.ride : (pel.ride && typeof pel.ride === "object" ? pel.ride : {});
      if (pel.is_complete) continue; // completed ones are owned by PASS 1
      const sched = pel.scheduled_start_time ?? ride.scheduled_start_time;
      if (!sched) continue;
      seenReservations.add(pelotonId);
      const { date: planned_for, time: specific_time } = localParts(sched, TZ);
      const r = await restWrite("POST", `workouts?on_conflict=member_id,peloton_reservation_id`, [{
        household_id: HOUSEHOLD_ID, member_id: MEMBER_ID,
        peloton_reservation_id: pelotonId, peloton_ride_id: ride.id ?? pel.ride_id ?? null,
        planned_for, specific_time, status: "planned", source: "peloton",
        session_type: normDiscipline(ride.fitness_discipline), class_title: ride.title ?? null,
        instructor: ride.instructor?.name ?? null, duration_min: ride.duration ? Math.round(ride.duration / 60) : null,
      }]);
      r.ok ? planned.upserted++ : (planned.errors++, console.error("reservation", r.err));
    } catch (e) { planned.errors++; console.error("reservation", pelotonId, String(e)); }
  }

  // PURE MIRROR: drop planned peloton rows whose reservation is gone (and never completed)
  const existingResv = await restGet(`workouts?member_id=eq.${MEMBER_ID}&source=eq.peloton&status=eq.planned&peloton_reservation_id=not.is.null&peloton_workout_id=is.null&select=id,peloton_reservation_id`);
  const staleIds = (Array.isArray(existingResv) ? existingResv : []).filter((w: any) => !seenReservations.has(w.peloton_reservation_id)).map((w: any) => w.id);
  if (staleIds.length) {
    const r = await restWrite("DELETE", `workouts?id=in.(${staleIds.join(",")})`, null);
    r.ok ? (planned.deleted = staleIds.length) : (planned.errors++, console.error("delete stale", r.err));
  }

  await writeHealth({ last_success_at: new Date().toISOString(), fail_count: 0, last_error: null });
  return json({ ok: true, user: me.username, completed, planned });
  } catch (e) {
    await writeHealth({ last_error: String(e).slice(0, 500), fail_count: prevFail + 1 });
    console.error("peloton-ingest fatal", String(e));
    return json({ ok: false, error: String(e).slice(0, 300) }, 500);
  }
});

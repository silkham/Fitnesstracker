// ============================================================
// health-ingest — receives Apple Health data from the
// "Health Auto Export" app and files workouts (+ weight) into
// the Fitness app's database.
//
// Deploy in Supabase → Edge Functions. Set these secrets:
//   INGEST_SECRET   a random string you choose (also goes in the app's header)
//   MEMBER_ID       your member_id    (00bd098a-d568-4f29-a12d-7acb8db01fbc)
//   HOUSEHOLD_ID    your household_id  (13b5e642-3f21-403c-8336-56976f177269)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// IMPORTANT: turn OFF "Verify JWT" for this function (auth is the shared secret).
// ============================================================

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// Pull "YYYY-MM-DD" out of any Health Auto Export date string (keeps the workout's local day)
function dayOf(s: unknown): string | null {
  const m = String(s ?? "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function parseDate(s: unknown): Date | null {
  if (!s) return null;
  let str = String(s).trim().replace(" ", "T").replace(/ ?([+-]\d{2}):?(\d{2})$/, "$1:$2");
  let d = new Date(str);
  if (!isNaN(d.getTime())) return d;
  d = new Date(String(s));
  return isNaN(d.getTime()) ? null : d;
}

// Map an Apple Health / Peloton workout name to a canonical type the
// workouts.session_type check constraint accepts (ride/run/strength/yoga/stretch/walk/other/rest).
function normType(name: unknown): string {
  const s = String(name ?? "").toLowerCase();
  if (s.includes("ride") || s.includes("cycl") || s.includes("bike") || s.includes("spin")) return "ride";
  if (s.includes("strength") || s.includes("functional") || s.includes("core") || s.includes("arms") || s.includes("legs") || s.includes("pilates")) return "strength";
  if (s.includes("yoga")) return "yoga";
  if (s.includes("stretch") || s.includes("mobility") || s.includes("cool down")) return "stretch";
  if (s.includes("walk") || s.includes("hik")) return "walk";
  if (s.includes("run")) return "run";
  return "other";
}

Deno.serve(async (req) => {
  if (req.method === "GET") return json({ ok: true, service: "health-ingest" });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const SECRET = Deno.env.get("INGEST_SECRET") ?? "";
  const auth = req.headers.get("authorization") ?? req.headers.get("x-ingest-secret") ?? "";
  if (!SECRET || !auth.includes(SECRET)) return json({ error: "unauthorized" }, 401);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const MEMBER_ID = Deno.env.get("MEMBER_ID")!;
  const HOUSEHOLD_ID = Deno.env.get("HOUSEHOLD_ID")!;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const workoutsRaw = body?.data?.workouts ?? body?.workouts ?? [];
  const metricsRaw = body?.data?.metrics ?? body?.metrics ?? [];

  // ---- workouts ----
  const workoutRows: any[] = [];
  for (const w of workoutsRaw) {
    const start = w.start ?? w.startDate ?? w.date;
    const planned_for = dayOf(start);
    if (!planned_for) continue;

    let duration_min: number | null = null;
    const s = parseDate(start), e = parseDate(w.end ?? w.endDate);
    if (s && e) duration_min = Math.max(1, Math.round((e.getTime() - s.getTime()) / 60000));
    else if (typeof w.duration === "number") duration_min = w.duration > 600 ? Math.round(w.duration / 60) : Math.round(w.duration);

    workoutRows.push({
      household_id: HOUSEHOLD_ID,
      member_id: MEMBER_ID,
      planned_for,
      session_type: normType(w.name ?? w.type),
      class_title: w.name ?? w.type ?? null, // keep Apple's original label as the subtitle
      duration_min,
      status: "done",
      source: "apple_health",
      health_uid: String(w.id ?? w.uuid ?? start),
    });
  }

  // ---- weight (only if your scale syncs body mass to Health) ----
  const weightRows: any[] = [];
  for (const metric of metricsRaw) {
    const name = String(metric?.name ?? "").toLowerCase();
    if (name.includes("weight") || name.includes("body_mass") || name.includes("mass")) {
      for (const pt of (metric.data ?? [])) {
        const logged_at = dayOf(pt.date);
        const kg = pt.qty ?? pt.value;
        if (logged_at && kg != null) weightRows.push({ household_id: HOUSEHOLD_ID, member_id: MEMBER_ID, logged_at, weight_kg: kg });
      }
    }
  }

  const upsert = async (table: string, onConflict: string, rows: any[]) => {
    if (!rows.length) return { sent: 0 };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });
    return { sent: rows.length, status: r.status, error: r.ok ? null : await r.text() };
  };

  const result = {
    ok: true,
    workouts: await upsert("workouts", "member_id,health_uid", workoutRows),
    weight: await upsert("weight_entries", "member_id,logged_at", weightRows),
  };
  return json(result);
});

// ============================================================
// health-ingest — receives Apple Health data (Health Auto Export) and files
// completed workouts + daily metrics into the Fitness DB.
//
// Secrets: INGEST_SECRET, MEMBER_ID, HOUSEHOLD_ID. (SUPABASE_URL + SERVICE key auto.)
// Turn OFF "Verify JWT" for this function.
//
// Completed workouts are MATCHED to planned (Peloton iCal) sessions on the same
// day + closest start time (any class type), upgrading the planned row to "done"
// and attaching metrics — so the instructor/class is kept and nothing duplicates.
// ============================================================

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

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
// local minutes-of-day from a "YYYY-MM-DD HH:MM ..." string
function startMinOf(s: unknown): number | null {
  const m = String(s ?? "").match(/\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})/);
  return m ? (+m[1] * 60 + +m[2]) : null;
}
function hhmmToMin(t: unknown): number | null {
  const m = String(t ?? "").match(/(\d{1,2}):(\d{2})/);
  return m ? (+m[1] * 60 + +m[2]) : null;
}
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
const num = (x: unknown): number | null => {
  const n = parseFloat(String(x ?? ""));
  return isNaN(n) ? null : n;
};
function toKcal(e: any): number | null {
  const q = num(e?.qty);
  if (q == null) return null;
  const u = String(e?.units ?? "").toLowerCase();
  if (u === "kj") return Math.round(q / 4.184);
  if (u === "cal") return Math.round(q / 1000);
  return Math.round(q);
}
function toKm(d: any): number | null {
  const q = num(d?.qty);
  if (q == null) return null;
  const u = String(d?.units ?? "").toLowerCase();
  const km = (u === "mi" || u === "mile" || u === "miles") ? q * 1.60934 : q;
  return Math.round(km * 100) / 100;
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

  // REST helpers (service role)
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
  const restGet = async (q: string) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: H });
    return r.ok ? await r.json() : [];
  };
  const restWrite = async (method: string, q: string, payload: any) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
      method, headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(payload),
    });
    return { ok: r.ok, status: r.status, err: r.ok ? null : await r.text() };
  };

  // ---- completed workouts: match to planned, else insert ----
  const counts = { matched: 0, inserted: 0, updated: 0, errors: 0 };
  for (const w of workoutsRaw) {
    const start = w.start ?? w.startDate ?? w.date;
    const planned_for = dayOf(start);
    if (!planned_for) continue;

    let duration_min: number | null = null;
    const sD = parseDate(start), eD = parseDate(w.end ?? w.endDate);
    if (sD && eD) duration_min = Math.max(1, Math.round((eD.getTime() - sD.getTime()) / 60000));
    else if (typeof w.duration === "number") duration_min = w.duration > 600 ? Math.round(w.duration / 60) : Math.round(w.duration);

    const hr = w.heartRate ?? {};
    const avgHr = num(hr?.avg?.qty) ?? num(w.avgHeartRate?.qty);
    const maxHr = num(hr?.max?.qty) ?? num(w.maxHeartRate?.qty);
    const type = normType(w.name ?? w.type);
    const health_uid = String(w.id ?? w.uuid ?? start);
    const metrics = {
      calories: toKcal(w.activeEnergyBurned) ?? toKcal(w.totalEnergy),
      avg_hr: avgHr != null ? Math.round(avgHr) : null,
      max_hr: maxHr != null ? Math.round(maxHr) : null,
      distance_km: toKm(w.distance),
      duration_min,
    };

    // 1) already synced? (idempotent re-runs) → refresh metrics
    const existing = await restGet(`workouts?member_id=eq.${MEMBER_ID}&health_uid=eq.${encodeURIComponent(health_uid)}&select=id&limit=1`);
    if (Array.isArray(existing) && existing.length) {
      const r = await restWrite("PATCH", `workouts?id=eq.${existing[0].id}`, { ...metrics, status: "done", source: "apple_health" });
      r.ok ? counts.updated++ : counts.errors++;
      continue;
    }

    // 2) match a planned session that day (closest start time; type as tiebreaker)
    const cands = await restGet(`workouts?member_id=eq.${MEMBER_ID}&planned_for=eq.${planned_for}&status=eq.planned&health_uid=is.null&select=id,specific_time,session_type,duration_min`);
    let target: any = null;
    if (Array.isArray(cands) && cands.length) {
      const startMin = startMinOf(start);
      let best = -1;
      for (const c of cands) {
        const ct = hhmmToMin(c.specific_time);
        if (ct != null && startMin != null) {
          const dist = Math.abs(ct - startMin);
          if (dist <= 90 && (best < 0 || dist < best)) { best = dist; target = c; }
        }
      }
      if (!target) {
        const sameType = cands.filter((c: any) => c.session_type === type);
        if (sameType.length === 1) target = sameType[0];
        else if (cands.length === 1) target = cands[0];
      }
    }

    if (target) {
      // upgrade the planned row → keep its instructor/class_title; attach metrics
      const r = await restWrite("PATCH", `workouts?id=eq.${target.id}`, {
        status: "done", done_at: new Date().toISOString(), health_uid, source: "apple_health", ...metrics,
      });
      r.ok ? counts.matched++ : counts.errors++;
    } else {
      // 3) unplanned → insert a new done row
      const r = await restWrite("POST", `workouts?on_conflict=member_id,health_uid`, [{
        household_id: HOUSEHOLD_ID, member_id: MEMBER_ID, planned_for,
        session_type: type, class_title: w.name ?? w.type ?? null,
        status: "done", source: "apple_health", health_uid, ...metrics,
      }]);
      r.ok ? counts.inserted++ : counts.errors++;
    }
  }

  // ---- weight (if a scale syncs body mass) ----
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

  // ---- daily health metrics (HRV, resting HR, VO2 max) for readiness ----
  const hm: Record<string, any> = {};
  for (const metric of metricsRaw) {
    const name = String(metric?.name ?? "").toLowerCase();
    let field: string | null = null;
    if (name.includes("variability")) field = "hrv";
    else if (name.includes("resting")) field = "resting_hr";
    else if (name.includes("vo2")) field = "vo2max";
    else if (name.includes("respiratory")) field = "respiratory_rate";
    if (!field) continue;
    for (const pt of (metric.data ?? [])) {
      const d = dayOf(pt.date);
      const v = num(pt.qty ?? pt.value ?? pt.Avg ?? pt.avg);
      if (!d || v == null) continue;
      hm[d] = hm[d] || { household_id: HOUSEHOLD_ID, member_id: MEMBER_ID, metric_date: d };
      hm[d][field] = field === "resting_hr" ? Math.round(v) : Math.round(v * 100) / 100;
    }
  }
  const metricRows = Object.values(hm);

  const bulk = async (table: string, onConflict: string, rows: any[]) => {
    if (!rows.length) return { sent: 0 };
    const r = await restWrite("POST", `${table}?on_conflict=${onConflict}`, rows);
    return { sent: rows.length, status: r.status, error: r.err };
  };

  return json({
    ok: true,
    workouts: counts,
    weight: await bulk("weight_entries", "member_id,logged_at", weightRows),
    metrics: await bulk("health_metrics", "member_id,metric_date", metricRows),
    debug_metric_names: metricsRaw.map((m: any) => m?.name),
  });
});

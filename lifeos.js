'use strict';

// ============================================================
// LifeOS ADAPTER
// ------------------------------------------------------------
// Publishes Stride's signals into the shared lifeos.signals
// contract (Project A — same DB, same household JWT). LifeOS is a
// read-mostly hub: Stride owns the truth and re-flips task/nudge
// status here on every boot, so the hub always reflects reality.
//
// This is a CLASSIC global <script> loaded AFTER app.js, so it
// shares app.js's global scope (State, activeMember, dayTotals,
// missedSlots, todayISO, isoDateAddDays, …). It adds NO DOM or
// onclick handlers — nothing here touches the onclick landmine.
//
// Contract columns: household_id, app, key, kind, title, detail,
// value, unit, trend (signed), state ('good'|'warn'|'bad'),
// cta_url, cta_label, due, sort_order, status ('open'|'done').
// Unique on (household_id, app, key) → stable keys upsert.
// ============================================================

const LIFEOS_APP = 'strive';
const LIFEOS_CTA = 'https://silkham.github.io/Fitnesstracker/'; // no hash routing → app home
const LIFEOS_DOW = ['sun','mon','tue','wed','thu','fri','sat'];

function lifeosWeightDate(w) {
  return new Date(w.measured_on || w.created_at || w.logged_at).getTime();
}

// Metric: latest weigh-in + signed ~weekly trend for the active member.
// Losing weight is GOOD here (weight-loss app) → down maps to state 'good'.
function lifeosWeightSignal(hid, mid) {
  const ws = State.weights
    .filter(w => w.member_id === mid && w.weight_kg != null)
    .sort((a, b) => lifeosWeightDate(b) - lifeosWeightDate(a)); // newest first
  if (!ws.length) return null;

  const latest = ws[0];
  const latestKg = +parseFloat(latest.weight_kg).toFixed(1);
  const latestT = lifeosWeightDate(latest);
  // nearest entry at least ~a week older; else the oldest we hold.
  const prior = ws.find(w => latestT - lifeosWeightDate(w) >= 6 * 86400000) || ws[ws.length - 1];
  const delta = prior === latest ? null : +(latestKg - parseFloat(prior.weight_kg)).toFixed(1);

  let state = null, detail;
  if (delta == null) { detail = 'First weigh-in'; }
  else if (Math.abs(delta) < 0.05) { detail = 'Steady this week'; }
  else {
    state = delta < 0 ? 'good' : 'warn';
    detail = `${delta < 0 ? '−' : '+'}${Math.abs(delta).toFixed(1)} kg this week`;
  }

  return {
    household_id: hid, app: LIFEOS_APP, key: 'weight', kind: 'metric',
    title: 'Weight', value: latestKg, unit: 'kg', trend: delta, state, detail,
    cta_url: LIFEOS_CTA, cta_label: 'Log weigh-in', sort_order: 10, status: 'open',
  };
}

// Metric: today's logged calories vs the active member's target.
// Under budget = good, near = warn, over = bad. No target → neutral.
function lifeosCaloriesSignal(hid, m) {
  const kcal = Math.round(lifeosDayTotals(todayISO()).kcal);
  const target = m && m.kcal_target ? +m.kcal_target : null;

  let state = null, detail;
  if (target) {
    const ratio = kcal / target;
    state = ratio > 1.0 ? 'bad' : (ratio > 0.9 ? 'warn' : 'good');
    detail = `${kcal.toLocaleString()} / ${target.toLocaleString()} kcal`;
  } else {
    detail = `${kcal.toLocaleString()} kcal logged`;
  }

  return {
    household_id: hid, app: LIFEOS_APP, key: 'calories-today', kind: 'metric',
    title: 'Calories today', value: kcal, unit: 'kcal', trend: null, state, detail,
    cta_url: LIFEOS_CTA, cta_label: 'Log food', sort_order: 20, status: 'open',
  };
}

// dayTotals lives in app.js; guard in case load order ever changes.
function lifeosDayTotals(date) {
  return typeof dayTotals === 'function'
    ? dayTotals(date)
    : { kcal: 0, protein: 0, carbs: 0, fat: 0 };
}

// Task: pending past-due meal slots for today (respects meal times via
// missedSlots). Flips to 'done' once nothing is outstanding today.
function lifeosLogFoodSignal(hid) {
  const today = todayISO();
  const missed = (typeof missedSlots === 'function' ? missedSlots() : [])
    .filter(x => x.date === today);
  const pending = missed.length > 0;

  return {
    household_id: hid, app: LIFEOS_APP, key: 'log-food-today', kind: 'task',
    title: pending
      ? `Log today's food${missed.length > 1 ? ` (${missed.length} slots left)` : ''}`
      : "Today's food logged",
    detail: pending ? missed.map(x => x.slot).join(', ') : 'All slots done',
    value: null, unit: null, trend: null,
    state: pending ? 'warn' : 'good',
    due: today, cta_url: LIFEOS_CTA, cta_label: 'Log food', sort_order: 30,
    status: pending ? 'open' : 'done',
  };
}

// Calendar: one row per day for the rolling week (today + next 6) so the LifeOS
// hub can show the whole week's workouts, not just tomorrow. dow-keyed and
// self-cleaning — a planned session → status 'open' with the workout label; an
// empty day → 'dismissed' (LifeOS then shows its own Plan / Rest-day controls and
// OWNS the rest-day acks, so this every-boot republish can't resurrect one).
function lifeosWeekSignals(hid, mid) {
  const start = todayISO();
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const iso = isoDateAddDays(start, i);
    const [y, mo, dd] = iso.split('-').map(Number);
    const dow = LIFEOS_DOW[new Date(y, mo - 1, dd).getDay()];  // local-safe weekday
    const w = State.workouts.find(x =>
      x.member_id === mid && x.planned_for === iso && x.status !== 'cancelled');
    const disp = w ? formatWorkoutDisplay(w) : null;
    rows.push({
      household_id: hid, app: LIFEOS_APP, key: 'day-' + dow, kind: 'task',
      title: w ? disp.primary : 'Rest day',
      detail: w ? disp.secondary : null,
      value: null, unit: null, trend: null, state: 'good',
      due: iso, cta_url: LIFEOS_CTA, cta_label: 'Open workout', sort_order: 40,
      status: w ? 'open' : 'dismissed',
    });
  }
  return rows;
}

// Fire-and-forget from the end of loadAll(). Best-effort: never throws,
// never blocks boot, quietly no-ops if the lifeos schema isn't reachable.
async function publishToLifeOS() {
  try {
    if (!State.client || !State.householdId) return;
    const hid = State.householdId;
    const m = activeMember();
    const mid = m && m.id;
    if (!mid) return;

    const now = new Date().toISOString();
    const rows = [
      lifeosWeightSignal(hid, mid),
      lifeosCaloriesSignal(hid, m),
      lifeosLogFoodSignal(hid),
      ...lifeosWeekSignals(hid, mid),
    ].filter(Boolean).map(r => ({ ...r, updated_at: now }));
    if (!rows.length) return;

    const { error } = await State.client
      .schema('lifeos')
      .from('signals')
      .upsert(rows, { onConflict: 'household_id,app,key' });
    if (error) console.warn('[LifeOS] publish failed:', error.message);
  } catch (e) {
    console.warn('[LifeOS] publish error:', e && e.message);
  }
}

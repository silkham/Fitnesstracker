'use strict';
// ============================================================
// Pure-logic tests — run from the REPO ROOT with JavaScriptCore:
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc tests/logic.test.js
//
// app.js is one big classic script that calls boot() at load, so it can't be
// loaded wholesale outside a browser. Instead we lift the named pure functions
// out of the source text and compile just those. That keeps the tests honest
// (they run the SHIPPED source, not a copy) without needing a DOM.
// ============================================================

const SRC_APP = readFile('app.js');
const SRC_LIFEOS = readFile('lifeos.js');

// Slice `function NAME(...) { ... }` out of src by brace matching. Loud on miss.
function extractFn(src, name) {
  const m = new RegExp('\\bfunction\\s+' + name + '\\s*\\(').exec(src);
  if (!m) throw new Error('function not found in source: ' + name);
  let i = src.indexOf('{', m.index);
  if (i < 0) throw new Error('no body for: ' + name);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('unbalanced braces for: ' + name);
}
// Grab a single-line `const NAME = ...;` declaration.
function extractConst(src, name) {
  const m = new RegExp('^const\\s+' + name + '\\s*=.*$', 'm').exec(src);
  if (!m) throw new Error('const not found in source: ' + name);
  return m[0];
}

const CONSTS = ['MED_WINDOW_MIN', 'MED_TITRATION_DAYS'];
const FNS = [
  'calorieBand', 'proteinBand', 'bandNote',
  'medWindowRemainingMs', 'medWindowLabel', 'medDoseDay', 'medDoseEligible',
  'isoDateAddDays', 'computeProjection',
];
const src = CONSTS.map(c => extractConst(SRC_APP, c))
  .concat(FNS.map(f => extractFn(SRC_APP, f)))
  .join('\n');
const A = new Function(src + '\nreturn {' + FNS.join(',') + '};')();

// ---- tiny assert harness ----
let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  print('  FAIL ' + label + '\n        expected ' + e + '\n        actual   ' + a);
}
function group(name) { print('\n' + name); }

// ============================================================
// 1) Calorie band — including the kcal_floor === null fallback
// ============================================================
group('calorieBand');
// -- floor set: three-zone band --
eq(A.calorieBand(1200, 2000, 1600).state, 'warn', 'below floor is a WARN, not a win');
eq(A.calorieBand(1200, 2000, 1600).zone, 'under', 'below floor → zone under');
eq(A.calorieBand(1200, 2000, 1600).delta, 400, 'under-floor delta counts up to the floor');
eq(A.calorieBand(1800, 2000, 1600).state, 'good', 'inside the band is good');
eq(A.calorieBand(1800, 2000, 1600).zone, 'in', 'inside the band → zone in');
eq(A.calorieBand(2400, 2000, 1600).state, 'bad', 'over target is bad');
eq(A.calorieBand(2400, 2000, 1600).delta, 400, 'over-target delta counts up from the target');
// -- boundaries --
eq(A.calorieBand(1600, 2000, 1600).state, 'good', 'exactly on the floor is inside the band');
eq(A.calorieBand(2000, 2000, 1600).state, 'good', 'exactly on the target is inside the band');
eq(A.calorieBand(1599, 2000, 1600).state, 'warn', 'one under the floor warns');
eq(A.calorieBand(2001, 2000, 1600).state, 'bad', 'one over the target is bad');
// -- floor === null: pre-4.15 behaviour, byte for byte --
eq(A.calorieBand(1200, 2000, null).state, 'good', 'no floor → big deficit still reads good (legacy)');
eq(A.calorieBand(1850, 2000, null).state, 'warn', 'no floor → ratio > 0.9 warns (legacy)');
eq(A.calorieBand(2100, 2000, null).state, 'bad', 'no floor → over target is bad (legacy)');
eq(A.calorieBand(1800, 2000, null).state, 'good', 'no floor → ratio exactly 0.9 is good (legacy)');
eq(A.calorieBand(2000, 2000, null).state, 'warn', 'no floor → ratio exactly 1.0 warns (legacy: >0.9 not >1.0)');
eq(A.calorieBand(1200, 2000, null).banded, false, 'no floor → not banded, so no new copy renders');
eq(A.calorieBand(1200, 2000, 1600).banded, true, 'floor set → banded');
eq(A.calorieBand(0, 2000, undefined).state, 'good', 'undefined floor behaves like null (legacy)');
eq(A.calorieBand(0, 2000, 0).state, 'good', 'floor 0 is falsy → legacy path, no divide-by-zero');
// -- no target at all --
eq(A.calorieBand(1200, null, 1600).state, null, 'no target → neutral, nothing to compare against');
eq(A.calorieBand(1200, null, 1600).zone, 'none', 'no target → zone none');

// ============================================================
// 2) Protein band
// ============================================================
group('proteinBand');
eq(A.proteinBand(160, 150, 120).state, 'good', 'at or above target is good');
eq(A.proteinBand(150, 150, 120).state, 'good', 'exactly on target is good');
eq(A.proteinBand(100, 150, 120).state, 'warn', 'below the floor warns');
eq(A.proteinBand(100, 150, 120).delta, 20, 'protein shortfall measured to the floor');
eq(A.proteinBand(130, 150, 120).state, null, 'between floor and target is neutral, not a warning');
eq(A.proteinBand(100, 150, null).state, null, 'no floor → below target alone never warns');
eq(A.proteinBand(100, null, 120).state, 'warn', 'floor without target still warns below it');
eq(A.proteinBand(130, null, 120).state, 'good', 'floor without target: at/above floor is good');
eq(A.proteinBand(0, null, null).state, null, 'no target and no floor → neutral');

// ============================================================
// 3) Band copy
// ============================================================
group('bandNote');
eq(A.bandNote(A.calorieBand(1120, 2000, 1600), '', true), '480 under floor', 'settled day names the shortfall');
eq(A.bandNote(A.calorieBand(1120, 2000, 1600), '', false), '480 to floor', 'day in progress reads as remaining');
eq(A.bandNote(A.calorieBand(2400, 2000, 1600), '', true), '400 over target', 'over-target copy');
eq(A.bandNote(A.proteinBand(100, 150, 120), 'g', true), '20g under floor', 'protein copy carries its unit');
eq(A.bandNote(A.proteinBand(160, 150, 120), 'g', true), 'protein target met', 'hitting protein target says so');
eq(A.bandNote(A.calorieBand(1200, null, null), '', true), '', 'neutral band renders no note');

// ============================================================
// 4) The 30-minute fasted window — absolute clock, crosses midnight
// ============================================================
group('medWindowRemainingMs');
const MIN = 60000;
// Dose at 23:50 LOCAL, checked at 00:05 the NEXT day: 15 minutes still to run.
const lateDose = new Date(2026, 6, 27, 23, 50, 0).toISOString();
const justAfterMidnight = new Date(2026, 6, 28, 0, 5, 0).getTime();
eq(A.medWindowRemainingMs(lateDose, justAfterMidnight), 15 * MIN, 'window survives the midnight boundary');
eq(A.medWindowLabel(A.medWindowRemainingMs(lateDose, justAfterMidnight)), '15 more minutes', 'countdown copy across midnight');
// Same dose, checked at 00:21 next day: the window has closed.
eq(A.medWindowRemainingMs(lateDose, new Date(2026, 6, 28, 0, 21, 0).getTime()), 0, 'window closed after midnight');
// Exactly on the boundary counts as closed, never negative.
eq(A.medWindowRemainingMs(lateDose, new Date(2026, 6, 28, 0, 20, 0).getTime()), 0, 'exactly 30 min in → closed');
// Ordinary same-day dose.
const morningDose = new Date(2026, 6, 27, 7, 12, 0).toISOString();
eq(A.medWindowRemainingMs(morningDose, new Date(2026, 6, 27, 7, 30, 0).getTime()), 12 * MIN, 'same-day mid-window');
eq(A.medWindowRemainingMs(morningDose, new Date(2026, 6, 27, 9, 0, 0).getTime()), 0, 'long past → closed');
// A dose logged with a time in the near future must not go negative or overrun.
eq(A.medWindowRemainingMs(morningDose, new Date(2026, 6, 27, 7, 12, 0).getTime()), 30 * MIN, 'at the moment of dosing → full window');
// Missing / unparseable input is closed, never a live countdown.
eq(A.medWindowRemainingMs(null, Date.now()), 0, 'no taken_at → no window');
eq(A.medWindowRemainingMs('', Date.now()), 0, 'empty taken_at → no window');
eq(A.medWindowRemainingMs('not a date', Date.now()), 0, 'unparseable taken_at → no window');

group('medWindowLabel');
eq(A.medWindowLabel(30 * MIN), '30 more minutes', 'full window');
eq(A.medWindowLabel(90000), '2 more minutes', 'rounds up to the whole minute');
eq(A.medWindowLabel(30000), 'under a minute', 'last minute reads as under a minute');
eq(A.medWindowLabel(0), 'under a minute', 'zero never renders a negative');

// ============================================================
// 5) Titration day count — informational only, never a dose decision
// ============================================================
group('medDoseDay / medDoseEligible');
eq(A.medDoseDay('2026-07-01', '2026-07-01'), 1, 'the first day on a dose is day 1');
eq(A.medDoseDay('2026-07-01', '2026-07-02'), 2, 'the next day is day 2');
eq(A.medDoseDay('2026-07-01', '2026-07-28'), 28, 'day 28 = 27 full days elapsed');
eq(A.medDoseDay('2026-07-01', '2026-07-29'), 29, 'day 29 = 28 full days elapsed');
// Across a month boundary and a 31-day month.
eq(A.medDoseDay('2026-01-31', '2026-02-01'), 2, 'counts across a month boundary');
eq(A.medDoseDay('2026-02-01', '2026-03-01'), 29, 'counts across a 28-day February');
eq(A.medDoseDay(null, '2026-07-28'), null, 'no dose start date → no day count');
eq(A.medDoseDay('2026-07-28', '2026-07-01'), null, 'a future start date does not count backwards');
// Eligibility requires a FULL 28 days at the level — conservative by a day.
eq(A.medDoseEligible('2026-07-01', '2026-07-27'), false, '26 days elapsed → not yet');
eq(A.medDoseEligible('2026-07-01', '2026-07-28'), false, '27 days elapsed → still not a full month');
eq(A.medDoseEligible('2026-07-01', '2026-07-29'), true, '28 full days elapsed → eligible to discuss');
eq(A.medDoseEligible('2026-07-01', '2026-09-01'), true, 'well past 28 days stays eligible');
eq(A.medDoseEligible(null, '2026-07-29'), false, 'no dose start date → never eligible');

// ============================================================
// 6) Projection is suppressed across a dose change
// ============================================================
group('computeProjection · titration caveat');
const W = [
  { logged_at: '2026-06-01', weight_kg: 100 },
  { logged_at: '2026-06-15', weight_kg: 99 },
  { logged_at: '2026-07-01', weight_kg: 98 },
  { logged_at: '2026-07-20', weight_kg: 97 },   // newest → window is 2026-05-25 onward
];
eq(A.computeProjection(W, 90, null).titrating, false, 'no medication → projection as before');
eq(A.computeProjection(W, 90, undefined).titrating, false, 'no dose date → projection as before');
eq(A.computeProjection(W, 90, '2026-07-01').titrating, true, 'dose changed inside the window → unreliable');
eq(A.computeProjection(W, 90, '2026-05-25').titrating, true, 'dose change on the window edge counts');
eq(A.computeProjection(W, 90, '2026-03-01').titrating, false, 'dose change long before the window is fine');
eq(A.computeProjection(W, 90, null).goalDate != null, true, 'a clean window still produces a goal date');
eq(A.computeProjection(W, 90, '2026-07-01').goalDate != null, true, 'the date is computed but the caller suppresses it');

// ============================================================
// 7) LifeOS calorie signal keeps the floor semantics
// ============================================================
group('lifeos protein signal wiring');
eq(/sort_order: 25/.test(SRC_LIFEOS), true, 'protein-today publishes at sort_order 25');
eq(/'protein-today'/.test(SRC_LIFEOS), true, 'protein-today key is published');
eq(/lifeosProteinSignal\(hid, m\)/.test(SRC_LIFEOS), true, 'protein signal is wired into publishToLifeOS');
eq(/key: 'med'/.test(SRC_LIFEOS), true, 'med adherence signal is published');

print('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
if (fail) throw new Error(fail + ' test(s) failed');

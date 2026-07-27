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

const CONSTS = [];
const FNS = ['calorieBand', 'proteinBand', 'bandNote'];
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

print('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
if (fail) throw new Error(fail + ' test(s) failed');

'use strict';
// ============================================================
// THE ONCLICK LANDMINE GUARD — run from the REPO ROOT:
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc tests/handlers.check.js
//
// Every inline on*="fn(...)" in index.html and app.js must resolve to a
// TOP-LEVEL function in app.js (or lifeos.js). Classic <script> is what makes
// those globals reachable; anything nested, or moved into a module, silently
// breaks the handler with no runtime error until a human taps it.
//
// Reports the distinct handler count so a diff in that number is visible.
// ============================================================

const SOURCES = ['app.js', 'index.html'];
const DEFINERS = ['app.js', 'lifeos.js'];

// Top-level = declared at column 0. A function indented inside another scope is
// NOT reachable from an inline handler, which is exactly the bug we're hunting.
const globals = new Set();
DEFINERS.forEach(f => {
  const src = readFile(f);
  const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) globals.add(m[1]);
  // `window.foo = ...` counts too — the documented escape hatch.
  const re2 = /^window\.([A-Za-z_$][\w$]*)\s*=/gm;
  while ((m = re2.exec(src))) globals.add(m[1]);
});

// Browser built-ins that legitimately appear inside inline handlers.
const BUILTINS = new Set([
  'parseInt', 'parseFloat', 'Number', 'String', 'Boolean', 'Array', 'Object',
  'encodeURIComponent', 'decodeURIComponent', 'alert', 'confirm', 'prompt',
  'setTimeout', 'clearTimeout', 'isNaN', 'JSON', 'Math', 'Date', 'if', 'for',
  'while', 'switch', 'return', 'typeof', 'catch', 'function',
]);

const called = new Map();   // name -> [where, ...]
let attrCount = 0;

SOURCES.forEach(file => {
  const src = readFile(file);
  // Every on*= attribute, single or double quoted.
  const attrRe = /\bon([a-z]+)\s*=\s*(["'])([\s\S]*?)\2/g;
  let a;
  while ((a = attrRe.exec(src))) {
    attrCount++;
    const body = a[3];
    const line = src.slice(0, a.index).split('\n').length;
    // Bare identifier followed by '(' and not preceded by '.' — i.e. a global call.
    const callRe = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
    let c;
    while ((c = callRe.exec(body))) {
      const name = c[2];
      if (BUILTINS.has(name)) continue;
      if (!called.has(name)) called.set(name, []);
      called.get(name).push(file + ':' + line);
    }
  }
});

const names = Array.from(called.keys()).sort();
const missing = names.filter(n => !globals.has(n));

print('Inline handler attributes scanned : ' + attrCount);
print('Distinct handler functions called : ' + names.length);
print('Top-level globals defined         : ' + globals.size);

if (missing.length) {
  print('\nUNRESOLVED — these inline handlers do not map to a top-level global:');
  missing.forEach(n => print('  ' + n + '  ← ' + called.get(n).slice(0, 3).join(', ')));
  throw new Error(missing.length + ' unresolved handler(s)');
}
print('\nOK — every inline handler resolves to a top-level global.');

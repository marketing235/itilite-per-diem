// Phase 4 build: src/calc-core.js + src/perdiem.js → dist/perdiem.js, one IIFE, no dependencies.
// Strips the ES module import/export syntax (used only so node --test can import calc-core),
// then checks the result parses and stays within ES2019 before writing. Fails loud otherwise.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Script } from 'node:vm';
import { gzipSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8').replace(/\r\n/g, '\n');
const OUT = 'dist/perdiem.js';
// Size targets for the served perdiem.min.js (docs/v1.2.0-separate-trips.md §11; v1.1.0 was 22 KB / 8 KB).
const BUDGET = 28 * 1024;
const GZIP_BUDGET = 10 * 1024;

function fail(msg) {
  console.error('build-js: ' + msg);
  process.exit(1);
}

function unmodule(src, name) {
  const out = src
    .replace(/^import\s[\s\S]*?\sfrom\s+'[^']+';\n/gm, '')
    .replace(/^export (?=(?:const|let|function) )/gm, '');
  if (/^\s*(?:import|export)\b/m.test(out)) fail(name + ': import/export left after stripping');
  return out.trim();
}

const body = [
  '// ---- src/calc-core.js ----',
  unmodule(read('src/calc-core.js'), 'src/calc-core.js'),
  '',
  '// ---- src/perdiem.js ----',
  unmodule(read('src/perdiem.js'), 'src/perdiem.js')
].join('\n');

const out = '/*! ITILITE per diem calculator | built from src/ by scripts/build-js.js, do not edit */\n' +
  '(function () {\n\'use strict\';\n\n' + body + '\n})();\n';

try {
  new Script(out, { filename: OUT });
} catch (err) {
  fail('output does not parse: ' + err.message);
}
// ES2020+ syntax guard: optional chaining, nullish coalescing, BigInt literals, class fields/#private.
const newer = /\?\.(?!\d)|\?\?|\b\d+n\b|#[A-Za-z_]\w*\s*[=;(]/.exec(out);
if (newer) fail('syntax newer than ES2019 near: ' + JSON.stringify(out.slice(newer.index - 30, newer.index + 30)));

// Served-size estimate. jsDelivr minifies perdiem.min.js on request; we have no minifier (zero
// dependencies), so strip comments and whitespace only — no renaming — which gives an upper bound
// on the real minified size (v1.0.1: 14.4 KB estimated, 11.1 KB real). The gzip figure is that
// text gzipped, also above the real one, by less: gzip already shrinks repeated long names.
// v1.1.0 step 2: measured 18.5 KB minified / 7.1 KB gzipped (terser 5, 16 Oct 2026); estimate 24.2 KB / 8.3 KB.
// v1.1.0 §17: measured 20.9 KB minified / 7.9 KB gzipped (terser 5, 16 Oct 2026); estimate 27.4 KB / 9.2 KB.
// v1.2.0 step 4: measured 27.9 KB minified / 9.99 KB gzipped (terser 5.51.2, 19 Oct 2026); estimate 37.0 KB / 11.9 KB.
// Only for the report: the stripped text is never written.
function stripForSize(src) {
  const ident = /[A-Za-z0-9_$\u0080-￿]/;
  const regexAfter = /[(,=:[!&|?{};+\-*%<>~^]$|\b(?:return|typeof|case)$/;
  let o = '';
  let i = 0;
  let pendingSpace = false;
  const emit = (s) => {
    const prev = o[o.length - 1];
    if (pendingSpace && prev && ((ident.test(prev) && ident.test(s[0])) ||
      ((prev === '+' || prev === '-') && s[0] === prev))) o += ' ';
    pendingSpace = false;
    o += s;
  };
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (/\s/.test(ch)) { pendingSpace = true; i++; continue; }
    if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; pendingSpace = true; continue; }
    if (ch === '/' && next === '*') { i = src.indexOf('*/', i + 2) + 2; pendingSpace = true; continue; }
    if (ch === '`') fail('stripForSize: template literals are not supported');
    if (ch === '\'' || ch === '"' || (ch === '/' && regexAfter.test(o.trimEnd()))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const cj = src[j];
        if (cj === '\\') { j += 2; continue; }
        if (ch === '/' && cj === '[') inClass = true;
        else if (ch === '/' && cj === ']') inClass = false;
        else if (cj === ch && !inClass) break;
        else if (cj === '\n') fail('stripForSize: unterminated literal at offset ' + i);
        j++;
      }
      if (ch === '/') { j++; while (/[a-z]/.test(src[j])) j++; } else j++;
      emit(src.slice(i, j));
      i = j;
      continue;
    }
    emit(ch);
    i++;
  }
  return o;
}

const stripped = stripForSize(out);
try {
  new Script(stripped, { filename: OUT + ' (size estimate)' });
} catch (err) {
  fail('size estimate does not parse, fix stripForSize: ' + err.message);
}

mkdirSync(new URL('dist/', root), { recursive: true });
writeFileSync(new URL(OUT, root), out);
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const bytes = Buffer.byteLength(out);
const served = Buffer.byteLength(stripped);
const gzipped = gzipSync(stripped).length;
console.log(`${OUT}: ${bytes} bytes (${kb(bytes)}) as built`);
console.log(`served (minified) estimate: ≤ ${served} bytes (${kb(served)}), budget ${kb(BUDGET)}`);
console.log(`served (gzipped) estimate: ≤ ${gzipped} bytes (${kb(gzipped)}), budget ${kb(GZIP_BUDGET)}`);
const MEASURE = 'measure the real size before tagging: npx terser dist/perdiem.js -c -m, then gzip it';
if (served > BUDGET) {
  console.warn(`build-js: WARNING — the minified upper-bound estimate is over the ${kb(BUDGET)} target; ${MEASURE}`);
}
if (gzipped > GZIP_BUDGET) {
  console.warn(`build-js: WARNING — the gzipped upper-bound estimate is over the ${kb(GZIP_BUDGET)} target; ${MEASURE}`);
}

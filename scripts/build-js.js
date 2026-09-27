// Phase 4 build: src/calc-core.js + src/perdiem.js → dist/perdiem.js, one IIFE, no dependencies.
// Strips the ES module import/export syntax (used only so node --test can import calc-core),
// then checks the result parses and stays within ES2019 before writing. Fails loud otherwise.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Script } from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8').replace(/\r\n/g, '\n');
const OUT = 'dist/perdiem.js';
const BUDGET = 15 * 1024;

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
// on the real minified size. Only for the report: the stripped text is never written.
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
console.log(`${OUT}: ${bytes} bytes (${kb(bytes)}) as built`);
console.log(`served (minified) estimate: ≤ ${served} bytes (${kb(served)}), budget ${kb(BUDGET)}`);
if (served > BUDGET) console.warn('build-js: WARNING — estimated served size is over the 15 KB target');

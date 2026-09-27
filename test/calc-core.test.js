// Golden tests from docs/phase-4-calculator.md, run against the committed data/ files.
// Run in several time zones: npm test, then TZ=America/Los_Angeles and TZ=Asia/Kolkata.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calculate, validateDates, buildLocationOptions, parseISODate, dayParts, fiscalYearOf, toISODate,
  formatMoney, summaryText, MESSAGES
} from '../src/calc-core.js';

const root = new URL('../', import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const meta = readJson('data/meta.json');

// Loads the state file for every fiscal year the trip touches, as perdiem.js does.
function run(state, location, departIso, returnIso) {
  const v = validateDates(departIso, returnIso, meta);
  const files = {};
  if (v.ok) v.fiscalYears.forEach((fy) => { files[fy] = readJson(`data/${fy}/${state}.json`); });
  return calculate({ departIso, returnIso, meta, files, location });
}

function money(r) {
  return { lodging: formatMoney(r.lodging), mie: formatMoney(r.mie), meals: formatMoney(r.meals),
    incidentals: formatMoney(r.incidentals), total: formatMoney(r.total) };
}

function breakdown(t, r) {
  t.diagnostic('date        FY    source    lodging  meals    incid.  M&IE     day total');
  r.rows.forEach((row) => {
    t.diagnostic([row.date, String(row.fiscalYear), (row.standard ? 'standard' : 'location').padEnd(8),
      formatMoney(row.lodging).padStart(7), formatMoney(row.meals).padStart(8),
      formatMoney(row.incidentals).padStart(6), formatMoney(row.mie).padStart(7),
      formatMoney(row.total).padStart(9)].join('  '));
  });
  const m = money(r);
  t.diagnostic(`TOTAL  days ${r.days}  lodging ${m.lodging}  meals ${m.meals}  incidentals ${m.incidentals}` +
    `  M&IE ${m.mie}  total ${m.total}`);
}

test('1. San Francisco CA (did 35), 1–3 Oct 2026', () => {
  const r = run('CA', '35', '2026-10-01', '2026-10-03');
  assert.equal(r.ok, true);
  assert.equal(r.days, 3);
  assert.deepEqual(r.rows.map((x) => x.lodging), [279, 279, 0]);
  assert.deepEqual(r.rows.map((x) => x.mie), [69, 92, 69]);
  assert.deepEqual(money(r),
    { lodging: '$558', mie: '$230', meals: '$217.50', incidentals: '$12.50', total: '$788' });
  assert.equal(summaryText(r, r.city, '2026-10-01', '2026-10-03'),
    '3 days in San Francisco, 1–3 Oct 2026. Total allowance $788.');
});

test('2. Washington DC, 1–4 Mar 2027', () => {
  const menu = buildLocationOptions(readJson('data/2027/DC.json'), 'Washington D.C.');
  assert.equal(menu.options.length, 1, 'DC has no standard-rate option');
  assert.equal(menu.preselect, '75');
  const r = run('DC', menu.preselect, '2027-03-01', '2027-03-04');
  assert.equal(r.ok, true);
  assert.equal(r.days, 4);
  assert.deepEqual(r.rows.map((x) => x.lodging), [295, 295, 295, 0]);
  assert.equal(formatMoney(r.lodging), '$885');
  assert.equal(formatMoney(r.mie), '$322');
  assert.equal(formatMoney(r.total), '$1,207');
});

test('3. Wilmington DE (did 78), 5 Oct 2026, same day', () => {
  const r = run('DE', '78', '2026-10-05', '2026-10-05');
  assert.equal(r.ok, true);
  assert.equal(r.days, 1);
  assert.equal(r.lodging, 0);
  assert.equal(formatMoney(r.lodging), '$0');
  assert.equal(formatMoney(r.mie), '$55.50');
  assert.equal(formatMoney(r.incidentals), '$3.75');
  assert.equal(formatMoney(r.total), '$55.50');
});

test('4. North Dakota, standard, 10–11 Oct 2026', () => {
  const menu = buildLocationOptions(readJson('data/2027/ND.json'), 'North Dakota');
  assert.deepEqual(menu.options, [{ value: 'std', label: 'All other North Dakota locations (standard rate)' }]);
  assert.equal(menu.preselect, 'std');
  const r = run('ND', 'std', '2026-10-10', '2026-10-11');
  assert.equal(r.ok, true);
  assert.equal(r.days, 2);
  assert.equal(formatMoney(r.lodging), '$113');
  assert.deepEqual(r.rows.map((x) => x.mie), [51, 51]);
  assert.equal(formatMoney(r.mie), '$102');
  assert.equal(formatMoney(r.total), '$215');
});

test('5. San Francisco CA (did 35), 29 Sep – 2 Oct 2026, crosses fiscal years', (t) => {
  const r = run('CA', '35', '2026-09-29', '2026-10-02');
  assert.equal(r.ok, true);
  breakdown(t, r);
  assert.equal(r.days, 4);
  assert.deepEqual(r.rows.map((x) => x.fiscalYear), [2026, 2026, 2027, 2027]);
  assert.deepEqual(r.rows.map((x) => x.lodging), [272, 272, 279, 0]);
  assert.deepEqual(r.rows.map((x) => x.mie), [69, 92, 92, 69]);
  assert.deepEqual(money(r),
    { lodging: '$823', mie: '$322', meals: '$304.50', incidentals: '$17.50', total: '$1,145' });
});

test('6. Allentown PA (FY2026 did 307), 28 Sep – 2 Oct 2026, falls back to FY2027 standard', (t) => {
  const r = run('PA', '307', '2026-09-28', '2026-10-02');
  assert.equal(r.ok, true);
  breakdown(t, r);
  assert.equal(r.days, 5);
  assert.deepEqual(r.rows.map((x) => x.standard), [false, false, false, true, true]);
  assert.deepEqual(r.rows.map((x) => x.lodging), [115, 115, 115, 113, 0]);
  assert.deepEqual(r.rows.map((x) => x.mie), [55.5, 74, 74, 68, 51]);
  assert.equal(formatMoney(r.lodging), '$458');
  assert.equal(formatMoney(r.mie), '$322.50');
  assert.equal(formatMoney(r.total), '$780.50');
});

test('7. Return before departure → error, no result', () => {
  const r = run('CA', '35', '2026-10-03', '2026-10-01');
  assert.equal(r.ok, false);
  assert.equal(r.error, MESSAGES.returnBeforeDepart);
  assert.equal(r.total, undefined);
});

test('8. Any date after 30 Sep 2027 → "not published yet"', () => {
  const crossing = run('CA', '35', '2027-09-29', '2027-10-02');
  assert.equal(crossing.ok, false);
  assert.equal(crossing.error, 'Rates for October 2027 aren’t published yet.');
  const after = run('CA', 'std', '2027-11-10', '2027-11-12');
  assert.equal(after.ok, false);
  assert.equal(after.error, 'Rates for November 2027 aren’t published yet.');
  const edge = run('CA', 'std', '2027-09-29', '2027-09-30');
  assert.equal(edge.ok, true, '30 Sep 2027 itself is still covered');
});

test('9. 2026-10-01 is 1 October in any time zone', (t) => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  t.diagnostic(`TZ env=${process.env.TZ || '(unset)'} resolved=${zone} ` +
    `offset(1 Oct 2026)=${new Date(2026, 9, 1).getTimezoneOffset()} min`);
  if (process.env.TZ) {
    // Compare ICU-canonical names: Asia/Kolkata resolves as its alias Asia/Calcutta.
    const wanted = new Intl.DateTimeFormat('en-US', { timeZone: process.env.TZ }).resolvedOptions().timeZone;
    assert.equal(zone, wanted, 'the TZ environment variable took effect');
  }
  const day = parseISODate('2026-10-01');
  assert.deepEqual(dayParts(day), { year: 2026, month: 9, date: 1 });
  assert.equal(toISODate(day), '2026-10-01');
  assert.equal(fiscalYearOf(day), 2027);
  assert.equal(fiscalYearOf(parseISODate('2026-09-30')), 2026);
  assert.equal(parseISODate('2026-02-30'), null);
});

// Golden tests from docs/phase-4-calculator.md (1–9) and docs/v1.1.0-multi-city.md (10–23), run
// against the committed data/ files, plus the CSV export and GA4 params helpers (v1.1 §8, §9) and
// the per-destination dates, breakdown and error targeting (v1.1 §17).
// Run in several time zones: npm test, then TZ=America/Los_Angeles and TZ=Asia/Kolkata.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calculate, validateDates, buildLocationOptions, parseISODate, dayParts, fiscalYearOf, toISODate,
  formatMoney, summaryText, MESSAGES, calculateTrip, validateTrip, tripSummaryText, locationType,
  buildCsv, analyticsParams, destinationSpans, spanText
} from '../src/calc-core.js';
import { states } from '../scripts/lib/states.js';

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

// ---- v1.1.0: multi-city trips and same-day rules (docs/v1.1.0-multi-city.md §13) ----

const STATE_NAMES = Object.fromEntries(states.map((s) => [s.abbreviation, s.displayName]));

// destinations: [state, location, arrive?] in travel order. Loads exactly the state files
// validateTrip says the trip needs, as perdiem.js will.
function runTrip(departIso, returnIso, destinations, over12) {
  const trip = {
    departIso, returnIso, over12, meta,
    destinations: destinations.map(([state, location, arrive]) =>
      ({ state, location, arrive: arrive || null, stateName: STATE_NAMES[state] }))
  };
  const v = validateTrip(trip, meta);
  const files = {};
  if (v.ok) v.needed.forEach(([fy, st]) => { (files[fy] = files[fy] || {})[st] = readJson(`data/${fy}/${st}.json`); });
  return calculateTrip({ ...trip, files });
}

function tripBreakdown(t, r) {
  t.diagnostic('date        FY    place                           source    lodging  M&IE     day total');
  r.rows.forEach((row) => {
    t.diagnostic([row.date, String(row.fiscalYear), row.place.padEnd(30),
      (row.standard ? 'standard' : 'location').padEnd(8), formatMoney(row.lodging).padStart(7),
      formatMoney(row.mie).padStart(7), formatMoney(row.total).padStart(9)].join('  '));
  });
  const m = money(r);
  t.diagnostic(`TOTAL  ${r.tripType}  days ${r.days}  lodging ${m.lodging}  meals ${m.meals}` +
    `  incidentals ${m.incidentals}  M&IE ${m.mie}  total ${m.total}`);
}

const NO_NIGHT = (place) => `No night in ${place}? Remove it: per diem follows where you sleep each night.`;

test('10. NYC → Pittsburgh, 12–16 Oct 2026', (t) => {
  const r = runTrip('2026-10-12', '2026-10-16', [['NY', '266'], ['PA', '318', '2026-10-14']]);
  assert.equal(r.ok, true);
  tripBreakdown(t, r);
  assert.equal(r.tripType, 'overnight');
  assert.equal(r.days, 5);
  assert.deepEqual(r.rows.map((x) => x.lodging), [358, 358, 144, 144, 0]);
  assert.deepEqual(r.rows.map((x) => x.mie), [69, 92, 80, 80, 60]);
  assert.deepEqual(r.rows.map((x) => x.destination), [0, 0, 1, 1, 1]);
  assert.deepEqual(money(r),
    { lodging: '$1,004', mie: '$381', meals: '$358.50', incidentals: '$22.50', total: '$1,385' });
  assert.equal(r.rateUsed, null);
  assert.deepEqual(r.destinations.map((d) => [d.place, d.startIso, d.endIso, d.nights, d.days, d.total]), [
    ['New York City', '2026-10-12', '2026-10-14', 2, 2, 358 + 358 + 69 + 92],
    ['Pittsburgh', '2026-10-14', '2026-10-16', 2, 3, 144 + 144 + 80 + 80 + 60]
  ]);
  assert.equal(tripSummaryText(r, '2026-10-12', '2026-10-16'),
    '5 days in New York City and Pittsburgh, 12–16 Oct 2026. Total allowance $1,385.');
  assert.equal(locationType(r.destinations), 'nsa');
});

test('11. San Francisco → Pittsburgh, changeover on 1 Oct (fiscal-year boundary)', (t) => {
  const r = runTrip('2026-09-29', '2026-10-03', [['CA', '35'], ['PA', '318', '2026-10-01']]);
  assert.equal(r.ok, true);
  tripBreakdown(t, r);
  assert.deepEqual(r.rows.map((x) => x.fiscalYear), [2026, 2026, 2027, 2027, 2027]);
  assert.deepEqual(r.rows.map((x) => x.lodging), [272, 272, 144, 144, 0]);
  assert.deepEqual(r.rows.map((x) => x.mie), [69, 92, 80, 80, 60]);
  assert.equal(formatMoney(r.lodging), '$832');
  assert.equal(formatMoney(r.mie), '$381');
  assert.equal(formatMoney(r.total), '$1,213');
});

test('12. Allentown → Philadelphia, fallback inside a multi-city trip', (t) => {
  const r = runTrip('2026-09-29', '2026-10-04', [['PA', '307'], ['PA', '317', '2026-10-02']]);
  assert.equal(r.ok, true);
  tripBreakdown(t, r);
  assert.deepEqual(r.rows.map((x) => x.standard), [false, false, true, false, false, false]);
  assert.deepEqual(r.rows.map((x) => x.lodging), [115, 115, 113, 227, 227, 0]);
  assert.deepEqual(r.rows.map((x) => x.mie), [55.5, 74, 68, 92, 92, 69]);
  assert.deepEqual(money(r),
    { lodging: '$797', mie: '$450.50', meals: '$423', incidentals: '$27.50', total: '$1,247.50' });
});

test('13. DC as destination 1 → Wilmington DE, 1–4 Mar 2027', (t) => {
  const r = runTrip('2027-03-01', '2027-03-04', [['DC', '75'], ['DE', '78', '2027-03-03']]);
  assert.equal(r.ok, true);
  tripBreakdown(t, r);
  assert.deepEqual(r.rows.map((x) => x.lodging), [295, 295, 127, 0]);
  assert.deepEqual(r.rows.map((x) => x.mie), [69, 92, 74, 55.5]);
  assert.equal(formatMoney(r.lodging), '$717');
  assert.equal(formatMoney(r.mie), '$290.50');
  assert.equal(formatMoney(r.total), '$1,007.50');
});

test('14. Three cities with a one-night middle stop, 9–14 Nov 2026', (t) => {
  const r = runTrip('2026-11-09', '2026-11-14',
    [['NY', '266'], ['NY', '258', '2026-11-11'], ['MA', '148', '2026-11-12']]);
  assert.equal(r.ok, true);
  tripBreakdown(t, r);
  assert.equal(r.days, 6);
  assert.deepEqual(r.rows.map((x) => x.lodging), [358, 358, 133, 213, 213, 0]);
  assert.deepEqual(r.rows.map((x) => x.mie), [69, 92, 86, 92, 92, 69]);
  assert.equal(formatMoney(r.lodging), '$1,275');
  assert.equal(formatMoney(r.mie), '$500');
  assert.equal(formatMoney(r.total), '$1,775');
  assert.deepEqual(r.destinations.map((d) => d.nights), [2, 1, 2]);
  assert.equal(tripSummaryText(r, '2026-11-09', '2026-11-14'),
    '6 days in New York City, Albany and Boston / Cambridge, 9–14 Nov 2026. Total allowance $1,775.');
});

test('15. Wisconsin standard → Milwaukee (mixed), 19–22 Oct 2026', (t) => {
  const r = runTrip('2026-10-19', '2026-10-22', [['WI', 'std'], ['WI', '397', '2026-10-21']]);
  assert.equal(r.ok, true);
  tripBreakdown(t, r);
  assert.deepEqual(r.rows.map((x) => x.lodging), [113, 113, 144, 0]);
  assert.deepEqual(r.rows.map((x) => x.mie), [51, 68, 80, 60]);
  assert.equal(formatMoney(r.lodging), '$370');
  assert.equal(formatMoney(r.mie), '$259');
  assert.equal(formatMoney(r.total), '$629');
  assert.deepEqual(r.destinations.map((d) => d.place), ['Wisconsin (standard rate)', 'Milwaukee']);
  assert.equal(locationType(r.destinations), 'mixed');
});

test('16. Day trip, Albany + New York City, switch on, 12 Oct 2026', (t) => {
  const r = runTrip('2026-10-12', '2026-10-12', [['NY', '258'], ['NY', '266']], true);
  assert.equal(r.ok, true);
  tripBreakdown(t, r);
  assert.equal(r.tripType, 'day');
  assert.equal(r.days, 1);
  assert.deepEqual(money(r),
    { lodging: '$0', mie: '$69', meals: '$65.25', incidentals: '$3.75', total: '$69' });
  assert.equal(r.rateUsed, 1);
  assert.equal(r.destinations[r.rateUsed].place, 'New York City');
  assert.equal(tripSummaryText(r, '2026-10-12', '2026-10-12'),
    '1 day in Albany and New York City, 12 Oct 2026. New York City’s rate applies (the highest). ' +
    'Total allowance $69.');
});

test('17. Day trip, switch off → $0 and the 12-hour message', () => {
  const r = runTrip('2026-10-12', '2026-10-12', [['NY', '266']], false);
  assert.equal(r.ok, true);
  assert.equal(r.tripType, 'day_short');
  assert.equal(r.days, 1);
  assert.deepEqual(money(r), { lodging: '$0', mie: '$0', meals: '$0', incidentals: '$0', total: '$0' });
  assert.equal(r.rows.length, 0);
  assert.equal(r.rateUsed, null);
  assert.equal(r.notice, 'Day trips of 12 hours or less don’t qualify for per diem under GSA rules.');
  assert.equal(tripSummaryText(r, '2026-10-12', '2026-10-12'), r.notice);
});

test('18. Day trip, one city, switch on = golden test 3 (Wilmington, $55.50)', () => {
  const r = runTrip('2026-10-05', '2026-10-05', [['DE', '78']], true);
  assert.equal(r.ok, true);
  assert.equal(r.tripType, 'day');
  assert.deepEqual(money(r),
    { lodging: '$0', mie: '$55.50', meals: '$51.75', incidentals: '$3.75', total: '$55.50' });
  assert.equal(r.rateUsed, 0);
  assert.equal(tripSummaryText(r, '2026-10-05', '2026-10-05'),
    '1 day in Wilmington, 5 Oct 2026. Total allowance $55.50.');
});

test('19. No night at destination 1 (Pittsburgh arrives on the departure date)', () => {
  const r = runTrip('2026-10-12', '2026-10-16', [['NY', '266'], ['PA', '318', '2026-10-12']]);
  assert.equal(r.ok, false);
  // Destination 1 can't be removed, so the message points at destination 2's date (§17).
  assert.equal(r.error,
    'No night in New York City? Check destination 2’s date: per diem follows where you sleep each night.');
  assert.equal(r.error, MESSAGES.noNightFirst('New York City'));
  assert.equal(r.incomplete, false);
  assert.deepEqual([r.dest, r.field], [1, 'arrive']);
  assert.equal(r.total, undefined);
});

test('20. Last destination has no night (Pittsburgh arrives on the return date)', () => {
  const r = runTrip('2026-10-12', '2026-10-16', [['NY', '266'], ['PA', '318', '2026-10-16']]);
  assert.equal(r.ok, false);
  assert.equal(r.error, NO_NIGHT('Pittsburgh'));
  assert.deepEqual([r.dest, r.field], [1, 'arrive']);
});

test('21. Destination 3 arrives before destination 2', () => {
  const r = runTrip('2026-11-09', '2026-11-14',
    [['NY', '266'], ['NY', '258', '2026-11-12'], ['MA', '148', '2026-11-11']]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Destination 3 starts before destination 2. Check the dates.');
  assert.equal(r.incomplete, false);
  assert.deepEqual([r.dest, r.field], [2, 'arrive']);
});

test('22. Destination 2 arrives after the return date', () => {
  const r = runTrip('2026-10-12', '2026-10-16', [['NY', '266'], ['PA', '318', '2026-10-17']]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Destination 2’s date must be between your departure and return dates.');
  assert.equal(r.incomplete, false);
  assert.deepEqual([r.dest, r.field], [1, 'arrive']);
});

test('23. Old markup (calc part): calculate() = one-destination calculateTrip; no switch pays 75%', () => {
  const v10 = (row) => ({ date: row.date, fiscalYear: row.fiscalYear, lodging: row.lodging, meals: row.meals,
    incidentals: row.incidentals, mie: row.mie, total: row.total, standard: row.standard });
  const cases = [['CA', '35', '2026-10-01', '2026-10-03'], ['DC', '75', '2027-03-01', '2027-03-04'],
    ['DE', '78', '2026-10-05', '2026-10-05'], ['ND', 'std', '2026-10-10', '2026-10-11'],
    ['CA', '35', '2026-09-29', '2026-10-02'], ['PA', '307', '2026-09-28', '2026-10-02']];
  cases.forEach(([st, loc, d, r]) => {
    const one = run(st, loc, d, r);
    const trip = runTrip(d, r, [[st, loc]]);
    assert.equal(one.ok, true);
    assert.equal(trip.ok, true);
    assert.deepEqual(money(one), money(trip), `${st} ${loc} ${d}`);
    assert.deepEqual(one.rows.map(v10), trip.rows.map(v10), `${st} ${loc} ${d}`);
  });
  // A page without the switch (over12 undefined) pays the 75% day, as v1.0.1.
  const r = runTrip('2026-10-05', '2026-10-05', [['DE', '78']]);
  assert.equal(r.tripType, 'day');
  assert.equal(formatMoney(r.total), '$55.50');
});

test('v1.1 validation order and prompts', () => {
  const dests = (d2) => [['NY', '266'], d2];
  // Trip dates come first.
  assert.equal(runTrip('2026-10-16', '2026-10-12', [['', '']]).error, MESSAGES.returnBeforeDepart);
  // Destination 1 keeps the v1.0.1 prompts.
  let r = runTrip('2026-10-12', '2026-10-16', [['', '']]);
  assert.deepEqual([r.error, r.incomplete], ['Choose a state', true]);
  r = runTrip('2026-10-12', '2026-10-16', [['NY', '']]);
  assert.deepEqual([r.error, r.incomplete], ['Choose a city or county', true]);
  // Destination k: Arrive on, then state, then city or county.
  r = runTrip('2026-10-12', '2026-10-16', dests(['', '', '']));
  assert.deepEqual([r.error, r.incomplete], ['Choose the date you arrive at destination 2.', true]);
  r = runTrip('2026-10-12', '2026-10-16', dests(['', '', '2026-10-14']));
  assert.deepEqual([r.error, r.incomplete], ['Choose a state for destination 2.', true]);
  r = runTrip('2026-10-12', '2026-10-16', dests(['PA', '', '2026-10-14']));
  assert.deepEqual([r.error, r.incomplete], ['Choose a city or county for destination 2.', true]);
  // Form order: destination 2's missing city wins over destination 3's bad date.
  r = runTrip('2026-10-12', '2026-10-16',
    [['NY', '266'], ['PA', '', '2026-10-14'], ['PA', '318', '2026-10-20']]);
  assert.equal(r.error, 'Choose a city or county for destination 2.');
  // An arrive date before departure is outside the trip.
  r = runTrip('2026-10-12', '2026-10-16', dests(['PA', '318', '2026-10-11']));
  assert.equal(r.error, 'Destination 2’s date must be between your departure and return dates.');
  // Same-day trips ignore Arrive on.
  r = runTrip('2026-10-12', '2026-10-12', dests(['NY', '258', '']), true);
  assert.equal(r.ok, true);
});

test('v1.1 needed lists only the state files the trip reads', () => {
  const needed = (d, r, ds) => validateTrip({ departIso: d, returnIso: r,
    destinations: ds.map(([state, location, arrive]) => ({ state, location, arrive })) }, meta).needed;
  assert.deepEqual(needed('2026-10-12', '2026-10-16', [['NY', '266'], ['PA', '318', '2026-10-14']]),
    [[2027, 'NY'], [2027, 'PA']]);
  assert.deepEqual(needed('2026-09-29', '2026-10-03', [['CA', '35'], ['PA', '318', '2026-10-01']]),
    [[2026, 'CA'], [2027, 'PA']]);
  assert.deepEqual(needed('2026-09-29', '2026-10-04', [['PA', '307'], ['PA', '317', '2026-10-02']]),
    [[2026, 'PA'], [2027, 'PA']]);
  assert.deepEqual(needed('2026-10-12', '2026-10-12', [['NY', '258'], ['PA', '318']]),
    [[2027, 'NY'], [2027, 'PA']]);
});

test('v1.1 rateGap: a did only in FY2026, in a state with no standard rate, across 1 Oct', () => {
  // Made-up state files: XX has no standard rate (like DC) and did 9 is gone in FY2027.
  const loc = (did, city) => ({ did, county: city + ' County', city, mie: 80,
    lodging: [150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150] });
  const xx = {
    2026: { state: 'XX', fiscalYear: 2026, standard: null, locations: [loc('9', 'Testville')] },
    2027: { state: 'XX', fiscalYear: 2027, standard: null, locations: [loc('10', 'Othertown')] }
  };
  const r = calculateTrip({ departIso: '2026-09-29', returnIso: '2026-10-02', meta,
    files: { 2026: { XX: xx[2026] }, 2027: { XX: xx[2027] } },
    destinations: [{ state: 'XX', location: '9', arrive: null, stateName: 'Testland' }] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Rates for Testville aren’t available for all of your dates.');
  assert.equal(r.error, MESSAGES.rateGap('Testville'));
  assert.equal(r.incomplete, false);
  assert.equal(r.total, undefined);
  // The v1.0 wrapper (and perdiem.js with one destination) keeps the v1.0.1 wording.
  const one = calculate({ departIso: '2026-09-29', returnIso: '2026-10-02', meta, files: xx, location: '9' });
  assert.equal(one.error, MESSAGES.locationGap);
});

test('v1.1 validateTrip throws for 0 and for 6 destinations', () => {
  const trip = (n) => ({ departIso: '2026-10-12', returnIso: '2026-10-16',
    destinations: Array.from({ length: n }, () => ({ state: 'NY', location: '266', arrive: null })) });
  assert.throws(() => validateTrip(trip(0), meta), /1 to 5 destinations required/);
  assert.throws(() => validateTrip(trip(6), meta), /1 to 5 destinations required/);
  assert.doesNotThrow(() => validateTrip(trip(1), meta));
  assert.doesNotThrow(() => validateTrip(trip(5), meta));
});

// ---- v1.1.0 step 2: CSV export and GA4 params (docs/v1.1.0-multi-city.md §8, §9) ----

const CSV_HEADER = '"Date","Fiscal year","Location","Lodging (USD)","Meals (USD)","Incidentals (USD)",' +
  '"Day total (USD)"';

// The file's lines, after checking the UTF-8 BOM and the CRLF after the last line.
function csvLines(csv) {
  assert.ok(csv.text.startsWith('﻿'), 'starts with the UTF-8 BOM');
  assert.ok(csv.text.endsWith('\r\n'), 'ends with CRLF');
  return csv.text.slice(1, -2).split('\r\n');
}

test('CSV for test 10 (NYC → Pittsburgh): Location column, subtotals, total, filename', () => {
  const r = runTrip('2026-10-12', '2026-10-16', [['NY', '266'], ['PA', '318', '2026-10-14']]);
  const csv = buildCsv(r, '2026-10-12', '2026-10-16', '2026-10-16');
  assert.equal(csv.filename, 'per-diem-multi-city-2026-10-12-to-2026-10-16.csv');
  assert.deepEqual(csvLines(csv), [
    '"ITILITE per diem estimate"',
    '"Trip: New York City, New York (12–14 Oct 2026); Pittsburgh, Pennsylvania (14–16 Oct 2026)"',
    '"Travel dates: 12–16 Oct 2026 (5 days)"',
    '"Source: U.S. General Services Administration per diem rates"',
    '"Generated 16 Oct 2026"',
    '',
    CSV_HEADER,
    '"2026-10-12","FY2027","New York City, New York","358","65.25","3.75","427"',
    '"2026-10-13","FY2027","New York City, New York","358","87","5","450"',
    '"Subtotal: New York City","","","716","152.25","8.75","877"',
    '"2026-10-14","FY2027","Pittsburgh, Pennsylvania","144","75","5","224"',
    '"2026-10-15","FY2027","Pittsburgh, Pennsylvania","144","75","5","224"',
    '"2026-10-16","FY2027","Pittsburgh, Pennsylvania","","56.25","3.75","60"',
    '"Subtotal: Pittsburgh","","","288","206.25","13.75","508"',
    '"Total","","","1004","358.50","22.50","1385"'
  ]);
});

test('CSV for golden test 1 = the v1.0.1 export plus the Location column', () => {
  // The v1.0.1 export of golden test 1, cell by cell (buildCsv in src/perdiem.js at v1.0.1).
  const v101 = [
    ['ITILITE per diem estimate'],
    ['San Francisco, California'],
    ['Travel dates: 1–3 Oct 2026 (3 days)'],
    ['Source: U.S. General Services Administration per diem rates'],
    ['Generated 16 Oct 2026'],
    [],
    ['Date', 'Fiscal year', 'Lodging (USD)', 'Meals (USD)', 'Incidentals (USD)', 'Day total (USD)'],
    ['2026-10-01', 'FY2027', '279', '65.25', '3.75', '348'],
    ['2026-10-02', 'FY2027', '279', '87', '5', '371'],
    ['2026-10-03', 'FY2027', '', '65.25', '3.75', '69'],
    ['Total', '', '558', '217.50', '12.50', '788']
  ];
  // Location becomes the third column: its title, the place on each day, empty on the Total row.
  const location = (cells) => (cells[0] === 'Date' ? 'Location' : cells[0] === 'Total' ? '' : 'San Francisco, California');
  const expected = v101.map((cells) => (cells.length < 2 ? cells
    : cells.slice(0, 2).concat([location(cells)], cells.slice(2))));
  const quote = (cells) => cells.map((s) => '"' + s + '"').join(',');
  const r = runTrip('2026-10-01', '2026-10-03', [['CA', '35']]);
  const csv = buildCsv(r, '2026-10-01', '2026-10-03', '2026-10-16');
  assert.equal(csv.filename, 'per-diem-ca-2026-10-01-to-2026-10-03.csv');
  assert.deepEqual(csvLines(csv), expected.map(quote));
});

test('CSV for test 16 (same-day, two stops): rate-used line, no subtotals', () => {
  const r = runTrip('2026-10-12', '2026-10-12', [['NY', '258'], ['NY', '266']], true);
  const csv = buildCsv(r, '2026-10-12', '2026-10-12', '2026-10-16');
  assert.equal(csv.filename, 'per-diem-multi-city-2026-10-12-to-2026-10-12.csv');
  assert.deepEqual(csvLines(csv), [
    '"ITILITE per diem estimate"',
    '"Trip: Albany, New York (12 Oct 2026); New York City, New York (12 Oct 2026)"',
    '"Same-day trip, away more than 12 hours. Rate used: New York City (the highest of your stops)."',
    '"Travel dates: 12 Oct 2026 (1 day)"',
    '"Source: U.S. General Services Administration per diem rates"',
    '"Generated 16 Oct 2026"',
    '',
    CSV_HEADER,
    '"2026-10-12","FY2027","New York City, New York","","65.25","3.75","69"',
    '"Total","","","0","65.25","3.75","69"'
  ]);
});

test('GA4 params for tests 10, 15, 16 and 17', () => {
  const params = (d, r, dests, over12) => analyticsParams(runTrip(d, r, dests, over12));
  assert.deepEqual(params('2026-10-12', '2026-10-16', [['NY', '266'], ['PA', '318', '2026-10-14']]),
    { state: 'NY', location_type: 'nsa', days: 5, destinations: 2, trip_type: 'overnight' });
  assert.deepEqual(params('2026-10-19', '2026-10-22', [['WI', 'std'], ['WI', '397', '2026-10-21']]),
    { state: 'WI', location_type: 'mixed', days: 4, destinations: 2, trip_type: 'overnight' });
  assert.deepEqual(params('2026-10-12', '2026-10-12', [['NY', '258'], ['NY', '266']], true),
    { state: 'NY', location_type: 'nsa', days: 1, destinations: 2, trip_type: 'day' });
  assert.deepEqual(params('2026-10-12', '2026-10-12', [['NY', '266']], false),
    { state: 'NY', location_type: 'nsa', days: 1, destinations: 1, trip_type: 'day_short' });
});

// ---- v1.1.0 UX additions (docs/v1.1.0-multi-city.md §17) ----

test('§17 destinationSpans: what each destination covers, from the dates alone', () => {
  const spans = (d, r, arrives) => destinationSpans(d, r, arrives);
  // Test 10: New York City 12–14 Oct, Pittsburgh 14–16 Oct.
  assert.deepEqual(spans('2026-10-12', '2026-10-16', [null, '2026-10-14']), [
    { startIso: '2026-10-12', endIso: '2026-10-14', nights: 2 },
    { startIso: '2026-10-14', endIso: '2026-10-16', nights: 2 }
  ]);
  // Test 14: three cities, one-night middle stop.
  assert.deepEqual(spans('2026-11-09', '2026-11-14', [null, '2026-11-11', '2026-11-12']).map((s) => s.nights), [2, 1, 2]);
  // Until destination 2's date is known, neither destination 1's end nor destination 2 is.
  assert.deepEqual(spans('2026-10-12', '2026-10-16', [null, '']), [null, null]);
  // Destination 3 without a date: destination 1 is known, 2 and 3 aren't.
  assert.deepEqual(spans('2026-11-09', '2026-11-14', [null, '2026-11-11', '']),
    [{ startIso: '2026-11-09', endIso: '2026-11-11', nights: 2 }, null, null]);
  // Out of order (test 21) or outside the trip (test 22): nothing from that destination on.
  assert.deepEqual(spans('2026-11-09', '2026-11-14', [null, '2026-11-12', '2026-11-11'])[1], null);
  assert.deepEqual(spans('2026-10-12', '2026-10-16', [null, '2026-10-17']), [null, null]);
  // A destination with no night shows 0 nights (test 19); the error comes from calculateTrip.
  assert.deepEqual(spans('2026-10-12', '2026-10-16', [null, '2026-10-12'])[0], { startIso: '2026-10-12', endIso: '2026-10-12', nights: 0 });
  // Same-day, missing or reversed dates: nothing.
  assert.deepEqual(spans('2026-10-12', '2026-10-12', [null, '']), [null, null]);
  assert.deepEqual(spans('', '2026-10-16', [null, '2026-10-14']), [null, null]);
  assert.deepEqual(spans('2026-10-16', '2026-10-12', [null, '2026-10-14']), [null, null]);
  // One destination covers the whole trip.
  assert.deepEqual(spans('2026-10-01', '2026-10-03', [null]), [{ startIso: '2026-10-01', endIso: '2026-10-03', nights: 2 }]);
});

test('§17 spanText and the per-destination totals for the breakdown', () => {
  assert.equal(spanText({ startIso: '2026-10-12', endIso: '2026-10-14', nights: 2 }), '12–14 Oct 2026 · 2 nights');
  assert.equal(spanText({ startIso: '2026-11-11', endIso: '2026-11-12', nights: 1 }), '11–12 Nov 2026 · 1 night');
  assert.equal(spanText({ startIso: '2026-09-29', endIso: '2026-10-01', nights: 2 }), '29 Sep – 1 Oct 2026 · 2 nights');
  assert.equal(spanText({ startIso: '2026-10-12', endIso: '2026-10-12', nights: 0 }), '12 Oct 2026 · 0 nights');
  // The breakdown lines of test 10, as the result panel shows them.
  const r = runTrip('2026-10-12', '2026-10-16', [['NY', '266'], ['PA', '318', '2026-10-14']]);
  assert.deepEqual(r.destinations.map((d) => [d.place, spanText(d), formatMoney(d.total)]), [
    ['New York City', '12–14 Oct 2026 · 2 nights', '$877'],
    ['Pittsburgh', '14–16 Oct 2026 · 2 nights', '$508']
  ]);
  // The lines add up to the trip total.
  assert.equal(r.destinations.reduce((s, d) => s + d.total, 0), r.total);
});

test('§17 every message says which destination and field it is about', () => {
  const at = (r) => [r.dest, r.field];
  // Trip dates (dest null).
  assert.deepEqual(at(runTrip('2026-10-16', '2026-10-12', [['NY', '266']])), [null, 'return']);
  assert.deepEqual(at(runTrip('2027-09-29', '2027-10-02', [['CA', '35']])), [null, 'return']);
  assert.deepEqual(at(runTrip('2027-11-10', '2027-11-12', [['CA', 'std']])), [null, 'depart']);
  assert.deepEqual(at(runTrip('2025-09-10', '2025-09-12', [['CA', 'std']])), [null, 'depart']);
  assert.deepEqual(at(runTrip('2026-01-01', '2027-01-05', [['CA', 'std']])), [null, 'return']);
  // Prompts: destination 1 and destination k.
  assert.deepEqual(at(runTrip('2026-10-12', '2026-10-16', [['', '']])), [0, 'state']);
  assert.deepEqual(at(runTrip('2026-10-12', '2026-10-16', [['NY', '']])), [0, 'location']);
  assert.deepEqual(at(runTrip('2026-10-12', '2026-10-16', [['NY', '266'], ['', '', '']])), [1, 'arrive']);
  assert.deepEqual(at(runTrip('2026-10-12', '2026-10-16', [['NY', '266'], ['', '', '2026-10-14']])), [1, 'state']);
  assert.deepEqual(at(runTrip('2026-10-12', '2026-10-16', [['NY', '266'], ['PA', '', '2026-10-14']])), [1, 'location']);
  // validateDates names the date too (used by the v1.0 API).
  assert.equal(validateDates('2026-10-16', '2026-10-12', meta).field, 'return');
  assert.equal(validateDates('', '2026-10-12', meta).field, 'depart');
});

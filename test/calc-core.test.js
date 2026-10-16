// Golden tests from docs/phase-4-calculator.md (1–9) and docs/v1.1.0-multi-city.md (10–23), run
// against the committed data/ files.
// Run in several time zones: npm test, then TZ=America/Los_Angeles and TZ=Asia/Kolkata.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calculate, validateDates, buildLocationOptions, parseISODate, dayParts, fiscalYearOf, toISODate,
  formatMoney, summaryText, MESSAGES, calculateTrip, validateTrip, tripSummaryText, locationType
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
  assert.equal(r.error, NO_NIGHT('New York City'));
  assert.equal(r.incomplete, false);
  assert.equal(r.total, undefined);
});

test('20. Last destination has no night (Pittsburgh arrives on the return date)', () => {
  const r = runTrip('2026-10-12', '2026-10-16', [['NY', '266'], ['PA', '318', '2026-10-16']]);
  assert.equal(r.ok, false);
  assert.equal(r.error, NO_NIGHT('Pittsburgh'));
});

test('21. Destination 3 arrives before destination 2', () => {
  const r = runTrip('2026-11-09', '2026-11-14',
    [['NY', '266'], ['NY', '258', '2026-11-12'], ['MA', '148', '2026-11-11']]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Destination 3 starts before destination 2. Check the dates.');
  assert.equal(r.incomplete, false);
});

test('22. Destination 2 arrives after the return date', () => {
  const r = runTrip('2026-10-12', '2026-10-16', [['NY', '266'], ['PA', '318', '2026-10-17']]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Destination 2’s date must be between your departure and return dates.');
  assert.equal(r.incomplete, false);
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

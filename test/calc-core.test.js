// Golden tests from docs/phase-4-calculator.md (1–9), docs/v1.1.0-multi-city.md (10–23),
// docs/v1.2.0-separate-trips.md (35–44) and docs/v1.3.0-compare-cities.md (46–54), run against the
// committed data/ files, plus the CSV export and GA4 params helpers (v1.1 §8, §9), the per-destination
// dates, breakdown and error targeting (v1.1 §17), the plan messages, validation order, summary, By trip
// lines, CSV and GA4 params (v1.2 §3, §4, §6, §7), and the compare validation order, summary and result
// lines (v1.3 §3, §5).
// Run in several time zones: npm test, then TZ=America/Los_Angeles and TZ=Asia/Kolkata.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calculate, validateDates, buildLocationOptions, parseISODate, dayParts, fiscalYearOf, toISODate,
  formatMoney, summaryText, MESSAGES, calculateTrip, validateTrip, tripSummaryText, locationType,
  buildCsv, analyticsParams, destinationSpans, spanText, calculatePlan, planNeeded, MAX_TRIPS, tripDatesText,
  planSummaryText, breakdownLines, planAnalyticsParams, buildPlanCsv, allShort, MAX_CITIES, calculateCompare,
  compareNeeded, compareSummaryText, compareLines, compareAnalyticsParams, buildCompareCsv
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

// ---- v1.2.0: separate trips (docs/v1.2.0-separate-trips.md §3, §10) ----

// Golden trips the plan tests reuse, as runTrip takes them: [departIso, returnIso, destinations, over12].
const SF_1 = ['2026-10-01', '2026-10-03', [['CA', '35']]];                                     // test 1: $788
const WILMINGTON_3 = ['2026-10-05', '2026-10-05', [['DE', '78']], true];                       // test 3: $55.50
const ND_4 = (d = '2026-10-10', r = '2026-10-11') => [d, r, [['ND', 'std']]];                // test 4: $215
const SF_5 = ['2026-09-29', '2026-10-02', [['CA', '35']]];                                     // test 5: $1,145
const NYC_PIT_10 = ['2026-10-12', '2026-10-16', [['NY', '266'], ['PA', '318', '2026-10-14']]]; // test 10: $1,385
const NYC = (d, r, over12) => [d, r, [['NY', '266']], over12];

// trips in entry order, each as runTrip takes it. Loads exactly the state files planNeeded lists, as
// perdiem.js will.
function runPlan(trips) {
  const plan = {
    meta,
    trips: trips.map(([departIso, returnIso, destinations, over12]) => ({
      departIso, returnIso, over12,
      destinations: destinations.map(([state, location, arrive]) =>
        ({ state, location, arrive: arrive || null, stateName: STATE_NAMES[state] }))
    }))
  };
  const files = {};
  planNeeded(plan, meta).forEach(([fy, st]) => { (files[fy] = files[fy] || {})[st] = readJson(`data/${fy}/${st}.json`); });
  return calculatePlan({ ...plan, files });
}

function planBreakdown(t, r) {
  r.trips.forEach((x, i) => {
    const m = money(x);
    t.diagnostic(`trip ${i + 1}  ${x.departIso} to ${x.returnIso}  ${x.tripType.padEnd(9)}  days ${x.days}` +
      `  lodging ${m.lodging}  M&IE ${m.mie}  total ${m.total}`);
    if (x.destinations.length > 1 && x.tripType === 'overnight') {
      x.destinations.forEach((d) => t.diagnostic(`          ${d.place.padEnd(30)}  ${formatMoney(d.total)}`));
    }
  });
  const m = money(r);
  t.diagnostic(`PLAN  trips ${r.trips.length}  days ${r.days}  lodging ${m.lodging}  meals ${m.meals}` +
    `  incidentals ${m.incidentals}  M&IE ${m.mie}  total ${m.total}`);
}

// Each trip in the plan is exactly its result on its own: its own 75% first and last day.
function sameAsAlone(plan, trips) {
  trips.forEach(([d, r, dests, over12], i) => {
    const alone = runTrip(d, r, dests, over12);
    assert.deepEqual(money(plan.trips[i]), money(alone), `trip ${i + 1}`);
    assert.deepEqual(plan.trips[i].rows, alone.rows, `trip ${i + 1}`);
  });
}

test('35. Two trips: San Francisco 1–3 Oct (test 1), North Dakota 10–11 Oct (test 4)', (t) => {
  const r = runPlan([SF_1, ND_4()]);
  assert.equal(r.ok, true);
  planBreakdown(t, r);
  assert.equal(r.trips.length, 2);
  assert.equal(r.days, 5);
  assert.deepEqual(money(r),
    { lodging: '$671', mie: '$332', meals: '$312', incidentals: '$20', total: '$1,003' });
  assert.deepEqual(r.trips.map((x) => formatMoney(x.total)), ['$788', '$215']);
  sameAsAlone(r, [SF_1, ND_4()]);
  // Plan rows: each trip's rows in entry order, each naming its trip. Both trips start and end at 75%.
  assert.deepEqual(r.rows.map((x) => x.trip), [0, 0, 0, 1, 1]);
  assert.deepEqual(r.rows.map((x) => x.mie), [69, 92, 69, 51, 51]);
});

test('36. Multi-city trip plus a day trip, not in date order: NYC → Pittsburgh (test 10), Wilmington (test 3)', (t) => {
  const r = runPlan([NYC_PIT_10, WILMINGTON_3]);
  assert.equal(r.ok, true);
  planBreakdown(t, r);
  assert.equal(r.days, 6);
  assert.deepEqual(money(r),
    { lodging: '$1,004', mie: '$436.50', meals: '$410.25', incidentals: '$26.25', total: '$1,440.50' });
  // Entry order, not date order: trip 2 (5 Oct) comes before trip 1 in time.
  assert.deepEqual(r.trips.map((x) => [x.departIso, x.tripType, formatMoney(x.total)]),
    [['2026-10-12', 'overnight', '$1,385'], ['2026-10-05', 'day', '$55.50']]);
  assert.deepEqual(r.trips[0].destinations.map((d) => [d.place, formatMoney(d.total)]),
    [['New York City', '$877'], ['Pittsburgh', '$508']]);
  assert.deepEqual(r.rows.map((x) => x.trip), [0, 0, 0, 0, 0, 1]);
  sameAsAlone(r, [NYC_PIT_10, WILMINGTON_3]);
});

test('37. Day trip with the switch off inside a plan: test 1, then New York City 12 Oct, switch off', (t) => {
  const r = runPlan([SF_1, NYC('2026-10-12', '2026-10-12', false)]);
  assert.equal(r.ok, true, 'the plan stays valid');
  planBreakdown(t, r);
  assert.equal(formatMoney(r.total), '$788');
  assert.equal(r.trips[1].tripType, 'day_short');
  assert.deepEqual(money(r.trips[1]), { lodging: '$0', mie: '$0', meals: '$0', incidentals: '$0', total: '$0' });
  assert.equal(r.trips[1].notice, MESSAGES.dayShort);
  assert.equal(r.trips[1].rows.length, 0);
  // Plan days are the sum of the trips' days (§3.2): the day trip still counts its day.
  assert.equal(r.days, 4);
  assert.equal(r.rows.length, 3);
});

test('38. Overlap: trip 1 12–16 Oct, trip 2 14–18 Oct', (t) => {
  const r = runPlan([NYC('2026-10-12', '2026-10-16'), NYC('2026-10-14', '2026-10-18')]);
  t.diagnostic(JSON.stringify(r));
  assert.deepEqual(r, { ok: false, error: 'Trip 2 overlaps trip 1. Check the dates.', incomplete: false,
    dest: null, field: 'depart', trip: 1 });
});

test('39. Touching, both directions', (t) => {
  // (a) Trip 2 departs the day trip 1 returns.
  const a = runPlan([NYC('2026-10-12', '2026-10-16'), NYC('2026-10-16', '2026-10-18')]);
  t.diagnostic('(a) ' + JSON.stringify(a));
  assert.deepEqual(a, { ok: false,
    error: 'Trip 2 starts the day trip 1 ends. For one continuous trip, use Add another destination instead.',
    incomplete: false, dest: null, field: 'depart', trip: 1 });
  // (b) Trip 2 is earlier in time and returns the day trip 1 departs.
  const b = runPlan([NYC('2026-10-16', '2026-10-18'), NYC('2026-10-12', '2026-10-16')]);
  t.diagnostic('(b) ' + JSON.stringify(b));
  assert.deepEqual(b, { ok: false,
    error: 'Trip 2 ends the day trip 1 starts. For one continuous trip, use Add another destination instead.',
    incomplete: false, dest: null, field: 'depart', trip: 1 });
  // Both hold only for two day trips on the same date: the first message.
  const same = runPlan([NYC('2026-10-12', '2026-10-12', true), NYC('2026-10-12', '2026-10-12', true)]);
  assert.equal(same.error, MESSAGES.tripTouch(2, 1, true));
  // A day trip on another trip's return day touches it; one in the middle of it overlaps it.
  assert.equal(runPlan([NYC('2026-10-12', '2026-10-16'), NYC('2026-10-16', '2026-10-16', true)]).error,
    MESSAGES.tripTouch(2, 1, true));
  assert.equal(runPlan([NYC('2026-10-12', '2026-10-16'), NYC('2026-10-14', '2026-10-14', true)]).error,
    MESSAGES.tripOverlap(2, 1));
  // A day apart is fine.
  assert.equal(runPlan([NYC('2026-10-12', '2026-10-16'), NYC('2026-10-17', '2026-10-18')]).ok, true);
});

test('40. Overlap entered in reverse: trip 1 20–22 Oct, trip 2 18–21 Oct', (t) => {
  const r = runPlan([NYC('2026-10-20', '2026-10-22'), NYC('2026-10-18', '2026-10-21')]);
  t.diagnostic(JSON.stringify(r));
  assert.deepEqual(r, { ok: false, error: 'Trip 2 overlaps trip 1. Check the dates.', incomplete: false,
    dest: null, field: 'depart', trip: 1 });
});

test('41. Five trips: test 4 (North Dakota standard) on 10–11, 13–14, 16–17, 19–20 and 22–23 Oct 2026', (t) => {
  const trips = [10, 13, 16, 19, 22].map((d) => ND_4(`2026-10-${d}`, `2026-10-${d + 1}`));
  const r = runPlan(trips);
  assert.equal(r.ok, true);
  planBreakdown(t, r);
  assert.equal(r.trips.length, 5);
  assert.equal(r.days, 10);
  assert.equal(formatMoney(r.total), '$1,075');
  assert.deepEqual(r.trips.map((x) => x.total), [215, 215, 215, 215, 215]);
  // No sixth trip (the page disables Add another trip at 5; the DOM check is in the harness).
  assert.equal(MAX_TRIPS, 5);
  assert.throws(() => runPlan(trips.concat([ND_4('2026-10-25', '2026-10-26')])), /1 to 5 trips required/);
});

test('42. Plan across the fiscal-year boundary: test 5 (29 Sep – 2 Oct 2026), then test 4', (t) => {
  const r = runPlan([SF_5, ND_4()]);
  assert.equal(r.ok, true);
  planBreakdown(t, r);
  assert.deepEqual(r.trips.map((x) => formatMoney(x.total)), ['$1,145', '$215']);
  assert.deepEqual(r.rows.map((x) => x.fiscalYear), [2026, 2026, 2027, 2027, 2027, 2027]);
  assert.equal(formatMoney(r.total), '$1,360');
  sameAsAlone(r, [SF_5, ND_4()]);
});

test('v1.2 messages name the trip once there are 2+ trips; a lone trip keeps v1.1', () => {
  const at = (r) => [r.error, r.incomplete, r.trip, r.dest, r.field];
  // One trip: calculateTrip's result exactly, plus trip 0.
  const lone = [NYC_PIT_10[0], NYC_PIT_10[1], [['NY', '266'], ['PA', '318', '2026-10-12']]];
  assert.deepEqual(runPlan([lone]), { ...runTrip(...lone), trip: 0 });
  assert.deepEqual(at(runPlan([NYC('2026-10-16', '2026-10-12')])),
    [MESSAGES.returnBeforeDepart, false, 0, null, 'return']);
  assert.deepEqual(at(runPlan([[SF_1[0], SF_1[1], [['', '']]]])), ['Choose a state', true, 0, 0, 'state']);
  assert.deepEqual(money(runPlan([NYC_PIT_10])), money(runTrip(...NYC_PIT_10)));
  // Two trips: each trip's own date messages.
  assert.deepEqual(at(runPlan([SF_1, NYC('', '2026-10-16')])),
    ['Choose the departure date for trip 2.', true, 1, null, 'depart']);
  assert.deepEqual(at(runPlan([SF_1, NYC('2026-10-12', '')])),
    ['Choose the return date for trip 2.', true, 1, null, 'return']);
  assert.deepEqual(at(runPlan([NYC('', ''), SF_1])),
    ['Choose the departure date for trip 1.', true, 0, null, 'depart']);
  assert.deepEqual(at(runPlan([SF_1, NYC('2026-10-16', '2026-10-12')])),
    ['Trip 2’s return date is before its departure date.', false, 1, null, 'return']);
  // Every other message gets the "Trip k: " prefix, keeping its destination and field.
  assert.deepEqual(at(runPlan([SF_1, ['2026-10-12', '2026-10-16', [['', '']]]])),
    ['Trip 2: Choose a state', true, 1, 0, 'state']);
  assert.deepEqual(at(runPlan([SF_1, ['2026-10-12', '2026-10-16', [['NY', '266'], ['PA', '', '2026-10-14']]]])),
    ['Trip 2: Choose a city or county for destination 2.', true, 1, 1, 'location']);
  assert.deepEqual(at(runPlan([lone, SF_1])),
    ['Trip 1: ' + MESSAGES.noNightFirst('New York City'), false, 0, 1, 'arrive']);
  assert.deepEqual(at(runPlan([SF_1, NYC('2027-09-29', '2027-10-02')])),
    ['Trip 2: Rates for October 2027 aren’t published yet.', false, 1, null, 'return']);
  assert.deepEqual(at(runPlan([SF_1, NYC('2026-10-12', '2027-10-12')])),
    ['Trip 2: Trips can be up to 365 days.', false, 1, null, 'return']);
});

test('v1.2 validation order: trip by trip in full, then the overlap check', () => {
  // Trip 1's no-night error needs its data file, and still wins over trip 2's missing date.
  const noNight = [NYC_PIT_10[0], NYC_PIT_10[1], [['NY', '266'], ['PA', '318', '2026-10-16']]];
  assert.equal(runPlan([noNight, NYC('', '')]).error, 'Trip 1: ' + NO_NIGHT('Pittsburgh'));
  // A trip's own problem wins over an overlap.
  const r = runPlan([NYC('2026-10-12', '2026-10-16'), ['2026-10-14', '2026-10-18', [['NY', '']]]]);
  assert.equal(r.error, 'Trip 2: Choose a city or county');
  // Each trip against the trips entered before it: trip 3's clash with trip 2 is found before trip 4's
  // with trip 1.
  const plan = runPlan([ND_4('2026-10-01', '2026-10-03'), ND_4('2026-10-05', '2026-10-08'),
    ND_4('2026-10-07', '2026-10-09'), ND_4('2026-10-02', '2026-10-04')]);
  assert.deepEqual([plan.error, plan.trip], ['Trip 3 overlaps trip 2. Check the dates.', 2]);
  // planNeeded stops at the first trip that fails without data: no files for the trips after it.
  const trips = [NYC_PIT_10, ['2026-10-20', '2026-10-21', [['', '']]], SF_1].map(([departIso, returnIso, ds]) =>
    ({ departIso, returnIso, destinations: ds.map(([state, location, arrive]) => ({ state, location, arrive })) }));
  assert.deepEqual(planNeeded({ trips }, meta), [[2027, 'NY'], [2027, 'PA']]);
  assert.deepEqual(planNeeded({ trips: [trips[0], trips[2]] }, meta), [[2027, 'NY'], [2027, 'PA'], [2027, 'CA']]);
  // 1 to 5 trips.
  assert.throws(() => calculatePlan({ meta, files: {}, trips: [] }), /1 to 5 trips required/);
});

test('v1.2 tripDatesText: each trip\'s dates line, from the dates alone', () => {
  assert.equal(tripDatesText('2026-10-12', '2026-10-16', 2), '12–16 Oct 2026 · 5 days · 2 cities');
  assert.equal(tripDatesText('2026-10-01', '2026-10-03', 1), '1–3 Oct 2026 · 3 days · 1 city');
  assert.equal(tripDatesText('2026-09-29', '2026-10-02', 1), '29 Sep – 2 Oct 2026 · 4 days · 1 city');
  assert.equal(tripDatesText('2026-10-12', '2026-10-12', 1), '12 Oct 2026 · day trip');
  assert.equal(tripDatesText('2026-10-12', '2026-10-12', 3), '12 Oct 2026 · day trip');
  // Nothing until both dates are known and in order; errors replace the line on the page.
  assert.equal(tripDatesText('', '2026-10-16', 1), '');
  assert.equal(tripDatesText('2026-10-12', '', 1), '');
  assert.equal(tripDatesText('2026-10-16', '2026-10-12', 1), '');
});

// ---- v1.2.0 step 4: plan results, export and analytics (docs/v1.2.0-separate-trips.md §4, §6, §7) ----

const NYC_SHORT = NYC('2026-10-12', '2026-10-12', false);

test('43. v1.1 markup (calc part): one trip gives exactly the v1.1 results; the v1.1 fixture has no trip hooks', () => {
  // The single-trip golden inputs of tests 1–6 and 10–18.
  const golden = [SF_1, ['2027-03-01', '2027-03-04', [['DC', '75']]], WILMINGTON_3, ND_4(), SF_5,
    ['2026-09-28', '2026-10-02', [['PA', '307']]], NYC_PIT_10,
    ['2026-09-29', '2026-10-03', [['CA', '35'], ['PA', '318', '2026-10-01']]],
    ['2026-09-29', '2026-10-04', [['PA', '307'], ['PA', '317', '2026-10-02']]],
    ['2027-03-01', '2027-03-04', [['DC', '75'], ['DE', '78', '2027-03-03']]],
    ['2026-11-09', '2026-11-14', [['NY', '266'], ['NY', '258', '2026-11-11'], ['MA', '148', '2026-11-12']]],
    ['2026-10-19', '2026-10-22', [['WI', 'std'], ['WI', '397', '2026-10-21']]],
    ['2026-10-12', '2026-10-12', [['NY', '258'], ['NY', '266']], true], NYC_SHORT, WILMINGTON_3];
  golden.forEach((g) => {
    const alone = runTrip(...g);
    const plan = runPlan([g]);
    assert.equal(plan.ok, true, g.join(' '));
    assert.deepEqual(money(plan), money(alone), g.join(' '));
    assert.deepEqual(plan.trips[0].rows, alone.rows, g.join(' '));
    // One trip's breakdown lines are v1.1's "By destination" lines.
    assert.deepEqual(breakdownLines(alone), alone.tripType === 'overnight' && alone.destinations.length > 1
      ? alone.destinations.map((d) => ({ place: d.place, dates: spanText(d), amount: d.total, sub: false })) : []);
    // GA4: the v1.1 params, plus trips 1.
    assert.deepEqual(planAnalyticsParams({ trips: [alone], days: alone.days }), { ...analyticsParams(alone), trips: 1 });
  });
  // The script runs separate trips only with trip-list, trip-template and add-trip; the v1.1 markup has
  // none of the v1.2 hooks, so Add another trip can't appear (DOM check: test/harness-v1.1.html).
  const fixture = (v) => readFileSync(new URL(`test/fixtures/03-calculator-${v}.html`, root), 'utf8');
  const v12Hooks = ['trip1-title', 'trip1-status', 'trip-list', 'trip-template', 'add-trip-wrap', 'add-trip',
    'add-trip-note', 'total-label', 'breakdown-title', 'trip-breakdown-template'];
  v12Hooks.forEach((h) => {
    assert.ok(!fixture('v1.1').includes(`data-pd="${h}"`), `v1.1 fixture has no ${h}`);
    assert.ok(fixture('v1.2').includes(`data-pd="${h}"`), `v1.2 fixture has ${h}`);
  });
  assert.ok(!fixture('v1.1').includes('data-pd-trip='));
  ['title', 'remove', 'status', 'depart', 'return', 'over12-wrap', 'over12', 'dest1-title', 'dest1-status', 'state',
    'location', 'dest-list', 'add-wrap', 'add', 'add-note'].forEach((h) =>
    assert.ok(fixture('v1.2').includes(`data-pd-trip="${h}"`), `v1.2 trip template has ${h}`));
});

test('44. CSV for test 36: trips header, trip title rows, destination and trip subtotals, total, filename', () => {
  const r = runPlan([NYC_PIT_10, WILMINGTON_3]);
  const csv = buildPlanCsv(r, '2026-10-16');
  assert.equal(csv.filename, 'per-diem-trips-2026-10-05-to-2026-10-16.csv');
  assert.deepEqual(csvLines(csv), [
    '"ITILITE per diem estimate"',
    '"Trips: 2"',
    '"Trip 1: New York City, New York (12–14 Oct 2026); Pittsburgh, Pennsylvania (14–16 Oct 2026)"',
    '"Trip 2: Wilmington, Delaware (5 Oct 2026)"',
    '"Source: U.S. General Services Administration per diem rates"',
    '"Generated 16 Oct 2026"',
    '',
    CSV_HEADER,
    '"Trip 1"',
    '"2026-10-12","FY2027","New York City, New York","358","65.25","3.75","427"',
    '"2026-10-13","FY2027","New York City, New York","358","87","5","450"',
    '"Subtotal: New York City","","","716","152.25","8.75","877"',
    '"2026-10-14","FY2027","Pittsburgh, Pennsylvania","144","75","5","224"',
    '"2026-10-15","FY2027","Pittsburgh, Pennsylvania","144","75","5","224"',
    '"2026-10-16","FY2027","Pittsburgh, Pennsylvania","","56.25","3.75","60"',
    '"Subtotal: Pittsburgh","","","288","206.25","13.75","508"',
    '"Subtotal: Trip 1","","","1004","358.50","22.50","1385"',
    '"Trip 2"',
    '"2026-10-05","FY2027","Wilmington, Delaware","","51.75","3.75","55.50"',
    '"Subtotal: Trip 2","","","0","51.75","3.75","55.50"',
    '"Total","","","1004","410.25","26.25","1440.50"'
  ]);
});

test('v1.2 CSV: a short day trip, a same-day trip with stops, a standard rate, and the filename span', () => {
  // Test 37: the switch-off day trip is one zero row with the note; the filename spans 1–12 Oct.
  const r37 = runPlan([SF_1, NYC_SHORT]);
  const csv37 = buildPlanCsv(r37, '2026-10-16');
  assert.equal(csv37.filename, 'per-diem-trips-2026-10-01-to-2026-10-12.csv');
  const lines37 = csvLines(csv37);
  assert.deepEqual(lines37.slice(1, 4), ['"Trips: 2"', '"Trip 1: San Francisco, California (1–3 Oct 2026)"',
    '"Trip 2: New York City, New York (12 Oct 2026)"']);
  assert.deepEqual(lines37.slice(-4), [
    '"Trip 2"',
    '"2026-10-12","FY2027","Day trip of 12 hours or less: no per diem","","0","0","0"',
    '"Subtotal: Trip 2","","","0","0","0","0"',
    '"Total","","","558","217.50","12.50","788"'
  ]);
  // A same-day trip with two stops keeps v1.1's rate-used line, under its own trip line; a standard
  // rate is named as in v1.1.
  const r = runPlan([ND_4(), ['2026-10-12', '2026-10-12', [['NY', '258'], ['NY', '266']], true]]);
  assert.deepEqual(csvLines(buildPlanCsv(r, '2026-10-16')).slice(1, 5), [
    '"Trips: 2"',
    '"Trip 1: Standard rate, North Dakota (10–11 Oct 2026)"',
    '"Trip 2: Albany, New York (12 Oct 2026); New York City, New York (12 Oct 2026)"',
    '"Same-day trip, away more than 12 hours. Rate used: New York City (the highest of your stops)."'
  ]);
});

test('v1.2 summary line and By trip lines for tests 35, 36, 37 and 41', () => {
  const r35 = runPlan([SF_1, ND_4()]);
  assert.equal(planSummaryText(r35),
    '2 trips, 5 days: San Francisco (1–3 Oct 2026) and North Dakota (standard rate) (10–11 Oct 2026). ' +
    'Total allowance $1,003.');
  assert.deepEqual(breakdownLines(r35), [
    { place: 'Trip 1: San Francisco', dates: '1–3 Oct 2026 · 3 days · 1 city', amount: 788, sub: false },
    { place: 'Trip 2: North Dakota (standard rate)', dates: '10–11 Oct 2026 · 2 days · 1 city', amount: 215, sub: false }
  ]);
  const r36 = runPlan([NYC_PIT_10, WILMINGTON_3]);
  assert.equal(planSummaryText(r36),
    '2 trips, 6 days: New York City and 1 more (12–16 Oct 2026) and Wilmington (5 Oct 2026). ' +
    'Total allowance $1,440.50.');
  assert.deepEqual(breakdownLines(r36), [
    { place: 'Trip 1: New York City and Pittsburgh', dates: '12–16 Oct 2026 · 5 days · 2 cities', amount: 1385, sub: false },
    { place: 'New York City', dates: '12–14 Oct 2026 · 2 nights', amount: 877, sub: true },
    { place: 'Pittsburgh', dates: '14–16 Oct 2026 · 2 nights', amount: 508, sub: true },
    { place: 'Trip 2: Wilmington', dates: '5 Oct 2026 · day trip', amount: 55.5, sub: false }
  ]);
  // The trip lines add up to the plan total.
  [r35, r36].forEach((r) => assert.equal(breakdownLines(r).filter((l) => !l.sub).reduce((s, l) => s + l.amount, 0), r.total));
  const r37 = runPlan([SF_1, NYC_SHORT]);
  assert.equal(planSummaryText(r37),
    '2 trips, 4 days: San Francisco (1–3 Oct 2026) and New York City (12 Oct 2026). Total allowance $788.');
  assert.equal(allShort(r37), false);
  // Three or more: the overall dates (the spec's example: three North Dakota trips of 2 days each).
  assert.equal(planSummaryText(runPlan([ND_4('2026-10-10', '2026-10-11'), ND_4('2026-10-13', '2026-10-14'),
    ND_4('2026-10-17', '2026-10-18')])), '3 trips, 6 days, 10–18 Oct 2026. Total allowance $645.');
  assert.equal(planSummaryText(runPlan([10, 13, 16, 19, 22].map((d) => ND_4(`2026-10-${d}`, `2026-10-${d + 1}`)))),
    '5 trips, 10 days, 10–23 Oct 2026. Total allowance $1,075.');
  // Only short day trips: the notice, and nothing to export (the page disables Export).
  const short = runPlan([NYC_SHORT, NYC('2026-10-14', '2026-10-14', false)]);
  assert.equal(short.ok, true);
  assert.equal(allShort(short), true);
  assert.equal(planSummaryText(short), MESSAGES.dayShort);
});

test('v1.2 GA4 params for tests 35, 36 and 37', () => {
  assert.deepEqual(planAnalyticsParams(runPlan([SF_1, ND_4()])),
    { state: 'CA', location_type: 'mixed', days: 5, destinations: 2, trip_type: 'overnight', trips: 2 });
  assert.deepEqual(planAnalyticsParams(runPlan([NYC_PIT_10, WILMINGTON_3])),
    { state: 'NY', location_type: 'nsa', days: 6, destinations: 3, trip_type: 'mixed', trips: 2 });
  assert.deepEqual(planAnalyticsParams(runPlan([SF_1, NYC_SHORT])),
    { state: 'CA', location_type: 'nsa', days: 4, destinations: 2, trip_type: 'mixed', trips: 2 });
  // Test 41: five overnight standard-rate trips.
  assert.deepEqual(planAnalyticsParams(runPlan([10, 13, 16, 19, 22].map((d) => ND_4(`2026-10-${d}`, `2026-10-${d + 1}`)))),
    { state: 'ND', location_type: 'standard', days: 10, destinations: 5, trip_type: 'overnight', trips: 5 });
});

// ---- v1.3.0: Compare cities (docs/v1.3.0-compare-cities.md §3, §5, §7, §8, §11) ----

// The cities the compare tests use, as [state, location].
const CITY = {
  SF: ['CA', '35'], NYC: ['NY', '266'], ND: ['ND', 'std'], PIT: ['PA', '318'], WIL: ['DE', '78'], WI: ['WI', 'std']
};

// cities: [state, location] in entry order. Loads exactly the state files compareNeeded lists, as perdiem.js
// will.
function runCompare(departIso, returnIso, cities, over12) {
  const cmp = { meta, departIso, returnIso, over12,
    cities: cities.map(([state, location]) => ({ state, location, stateName: STATE_NAMES[state] })) };
  const files = {};
  compareNeeded(cmp, meta).forEach(([fy, st]) => { (files[fy] = files[fy] || {})[st] = readJson(`data/${fy}/${st}.json`); });
  return calculateCompare({ ...cmp, files });
}

function compareBreakdown(t, r) {
  r.cities.forEach((x, i) => {
    const m = money(x);
    t.diagnostic(`city ${i + 1}  ${x.destinations[0].place.padEnd(30)}  ${x.tripType.padEnd(9)}  days ${x.days}` +
      `  lodging ${m.lodging.padStart(6)}  M&IE ${m.mie.padStart(7)}  total ${m.total.padStart(6)}` +
      (r.lowest.includes(i) ? '  LOWEST' : '') + (r.highest.includes(i) ? '  highest' : ''));
  });
  t.diagnostic(`COMPARE  days ${r.days}  ${r.tripType}  lowest [${r.lowest}]  highest [${r.highest}]`);
}

// Each city is exactly its one-destination trip on its own (§2): its own 75% first and last day.
function sameAsAloneCities(r, departIso, returnIso, cities, over12) {
  cities.forEach((c, i) => {
    const alone = runTrip(departIso, returnIso, [c], over12);
    assert.deepEqual(money(r.cities[i]), money(alone), `city ${i + 1}`);
    assert.deepEqual(r.cities[i].rows, alone.rows, `city ${i + 1}`);
  });
}

test('46. 12–14 Oct 2026: San Francisco, New York City, North Dakota (standard)', (t) => {
  const cities = [CITY.SF, CITY.NYC, CITY.ND];
  const r = runCompare('2026-10-12', '2026-10-14', cities);
  assert.equal(r.ok, true);
  compareBreakdown(t, r);
  assert.deepEqual(r.cities.map((x) => formatMoney(x.total)), ['$788', '$946', '$396']);
  assert.equal(r.days, 3);
  assert.equal(r.tripType, 'overnight');
  assert.deepEqual(r.lowest, [2]);
  assert.deepEqual(r.highest, [1]);
  sameAsAloneCities(r, '2026-10-12', '2026-10-14', cities);
  // Nothing is added up.
  assert.equal(r.total, undefined);
});

test('47. Same dates, five cities: + Pittsburgh, Wilmington DE', (t) => {
  const cities = [CITY.SF, CITY.NYC, CITY.ND, CITY.PIT, CITY.WIL];
  const r = runCompare('2026-10-12', '2026-10-14', cities);
  assert.equal(r.ok, true);
  compareBreakdown(t, r);
  assert.deepEqual(r.cities.map((x) => formatMoney(x.total)), ['$788', '$946', '$396', '$488', '$439']);
  assert.deepEqual(r.lowest, [2]);
  assert.deepEqual(r.highest, [1]);
  sameAsAloneCities(r, '2026-10-12', '2026-10-14', cities);
  // No sixth city (the page disables Add another city at 5; the DOM check is in the harness).
  assert.equal(MAX_CITIES, 5);
  assert.throws(() => runCompare('2026-10-12', '2026-10-14', cities.concat([CITY.WI])), /up to 5 cities/);
});

test('48. 5 Oct 2026, day trip, switch on: San Francisco, New York City, Pittsburgh', (t) => {
  const cities = [CITY.SF, CITY.NYC, CITY.PIT];
  const r = runCompare('2026-10-05', '2026-10-05', cities, true);
  assert.equal(r.ok, true);
  compareBreakdown(t, r);
  assert.deepEqual(r.cities.map((x) => formatMoney(x.total)), ['$69', '$69', '$60']);
  assert.equal(r.days, 1);
  assert.equal(r.tripType, 'day');
  assert.deepEqual(r.lowest, [2]);
  assert.deepEqual(r.highest, [0, 1]);
  sameAsAloneCities(r, '2026-10-05', '2026-10-05', cities, true);
  assert.deepEqual(compareAnalyticsParams(r),
    { state: 'CA', cities: 3, days: 1, trip_type: 'day', location_type: 'nsa' });
});

test('49. 12–14 Oct 2026: Wisconsin (standard), North Dakota (standard), San Francisco — tie at the lowest', (t) => {
  const r = runCompare('2026-10-12', '2026-10-14', [CITY.WI, CITY.ND, CITY.SF]);
  assert.equal(r.ok, true);
  compareBreakdown(t, r);
  assert.deepEqual(r.cities.map((x) => formatMoney(x.total)), ['$396', '$396', '$788']);
  assert.deepEqual(r.lowest, [0, 1], 'both tied cities are the lowest');
  assert.deepEqual(r.highest, [2]);
});

test('50. 5 Oct 2026, switch off: San Francisco, New York City', (t) => {
  const r = runCompare('2026-10-05', '2026-10-05', [CITY.SF, CITY.NYC], false);
  assert.equal(r.ok, true, 'the comparison stays valid');
  compareBreakdown(t, r);
  assert.equal(r.tripType, 'day_short');
  assert.deepEqual(r.cities.map((x) => x.total), [0, 0]);
  r.cities.forEach((x) => assert.equal(x.notice, MESSAGES.dayShort));
  assert.deepEqual(r.lowest, [], 'no lowest');
  assert.deepEqual(r.highest, []);
  assert.equal(compareSummaryText(r, '2026-10-05', '2026-10-05'), MESSAGES.dayShort, 'the 12-hour notice');
  // Export is enabled only with a city above $0 (the page's check; DOM check in the harness).
  assert.equal(r.cities.some((x) => x.total > 0), false);
});

test('51. 29 Sep – 2 Oct 2026 (fiscal-year boundary): San Francisco, New York City, Pittsburgh, North Dakota', (t) => {
  const cities = [CITY.SF, CITY.NYC, CITY.PIT, CITY.ND];
  const r = runCompare('2026-09-29', '2026-10-02', cities);
  assert.equal(r.ok, true);
  compareBreakdown(t, r);
  r.cities.forEach((x) => assert.deepEqual(x.rows.map((row) => row.fiscalYear), [2026, 2026, 2027, 2027]));
  assert.deepEqual(r.cities.map((x) => formatMoney(x.total)), ['$1,145', '$1,364', '$700', '$571']);
  assert.equal(r.days, 4);
  assert.deepEqual(r.lowest, [3]);
  assert.deepEqual(r.highest, [1]);
  sameAsAloneCities(r, '2026-09-29', '2026-10-02', cities);
});

test('52. Same city twice (San Francisco, San Francisco)', (t) => {
  const r = runCompare('2026-10-12', '2026-10-14', [CITY.SF, CITY.SF]);
  t.diagnostic(JSON.stringify(r));
  assert.deepEqual(r, { ok: false, error: 'City 2 is the same as city 1. Choose a different city.',
    incomplete: false, city: 1, field: 'location' });
});

test('53. CSV for test 46: header lines, one row per city, Lowest, filename', () => {
  const r = runCompare('2026-10-12', '2026-10-14', [CITY.SF, CITY.NYC, CITY.ND]);
  const csv = buildCompareCsv(r, '2026-10-12', '2026-10-14', '2026-10-16');
  assert.equal(csv.filename, 'per-diem-compare-2026-10-12-to-2026-10-14.csv');
  assert.deepEqual(csvLines(csv), [
    '"ITILITE per diem comparison"',
    '"Travel dates: 12–14 Oct 2026 (3 days)"',
    '"Cities: 3"',
    '"Source: U.S. General Services Administration per diem rates"',
    '"Generated 16 Oct 2026"',
    '',
    '"City","State","Lodging (USD)","Meals (USD)","Incidentals (USD)","Total (USD)","Lowest"',
    '"San Francisco","California","558","217.50","12.50","788",""',
    '"New York City","New York","716","217.50","12.50","946",""',
    '"Standard rate","North Dakota","226","157.50","12.50","396","Yes"'
  ]);
});

test('54. GA4 for test 46: perdiem_compare params', () => {
  const r = runCompare('2026-10-12', '2026-10-14', [CITY.SF, CITY.NYC, CITY.ND]);
  assert.deepEqual(compareAnalyticsParams(r),
    { state: 'CA', cities: 3, days: 3, trip_type: 'overnight', location_type: 'mixed' });
  // Codes and counts only: no dates, place names or anything typed.
  assert.ok(!JSON.stringify(compareAnalyticsParams(r)).match(/2026|San Francisco|New York|North Dakota/));
});

test('v1.3 validation order: dates, each city\'s State and City, same city twice, fewer than 2, each city\'s own calculation', () => {
  const at = (r) => [r.error, r.incomplete, r.city, r.field];
  const two = [CITY.SF, CITY.NYC];
  // 1. Dates, unprefixed v1.1 messages (empty dates as the page words them for one trip).
  assert.deepEqual(at(runCompare('', '2026-10-14', two)), ['Choose your departure date', true, null, 'depart']);
  assert.deepEqual(at(runCompare('2026-10-12', '', two)), ['Choose your return date', true, null, 'return']);
  assert.deepEqual(at(runCompare('2026-10-14', '2026-10-12', two)), [MESSAGES.returnBeforeDepart, false, null, 'return']);
  assert.deepEqual(at(runCompare('2027-09-29', '2027-10-02', two)),
    ['Rates for October 2027 aren’t published yet.', false, null, 'return']);
  assert.deepEqual(at(runCompare('2026-10-12', '2027-10-12', two)), [MESSAGES.tooLong, false, null, 'return']);
  // Dates win over everything else.
  assert.deepEqual(at(runCompare('', '', [['', ''], CITY.SF, CITY.SF])), ['Choose your departure date', true, null, 'depart']);
  // 2. Each city in order: State, then City, prefixed (prompts, not errors).
  assert.deepEqual(at(runCompare('2026-10-12', '2026-10-14', [['', ''], ['', '']])), ['City 1: Choose a state', true, 0, 'state']);
  assert.deepEqual(at(runCompare('2026-10-12', '2026-10-14', [['CA', ''], ['', '']])),
    ['City 1: Choose a city or county', true, 0, 'location']);
  assert.deepEqual(at(runCompare('2026-10-12', '2026-10-14', [CITY.SF, ['', '']])), ['City 2: Choose a state', true, 1, 'state']);
  assert.deepEqual(at(runCompare('2026-10-12', '2026-10-14', [CITY.SF, CITY.NYC, ['PA', '']])),
    ['City 3: Choose a city or county', true, 2, 'location']);
  // A city still being chosen wins over a duplicate elsewhere.
  assert.deepEqual(at(runCompare('2026-10-12', '2026-10-14', [CITY.SF, CITY.SF, ['', '']])),
    ['City 3: Choose a state', true, 2, 'state']);
  // 3. Duplicates: each city against the ones before it; the later one is marked.
  assert.deepEqual(at(runCompare('2026-10-12', '2026-10-14', [CITY.SF, CITY.NYC, CITY.SF])),
    ['City 3 is the same as city 1. Choose a different city.', false, 2, 'location']);
  assert.deepEqual(at(runCompare('2026-10-12', '2026-10-14', [CITY.SF, CITY.NYC, CITY.NYC, CITY.SF])),
    ['City 3 is the same as city 2. Choose a different city.', false, 2, 'location']);
  assert.deepEqual(at(runCompare('2026-10-12', '2026-10-14', [CITY.ND, CITY.ND])),
    ['City 2 is the same as city 1. Choose a different city.', false, 1, 'location']);
  // Two states' standard rates are two cities, even at the same amount (test 49).
  assert.equal(runCompare('2026-10-12', '2026-10-14', [CITY.WI, CITY.ND]).ok, true);
  // 4. Fewer than 2 cities: a prompt about the whole comparison.
  assert.deepEqual(at(runCompare('2026-10-12', '2026-10-14', [CITY.SF])), [MESSAGES.addCity, true, null, null]);
  assert.deepEqual(at(runCompare('2026-10-12', '2026-10-14', [])), ['Add another city to compare.', true, null, null]);
  // 5. Each city's own calculation, prefixed: a rate gap (made-up XX: did 9 only in FY2026, no standard rate).
  const loc = (did, city) => ({ did, county: city + ' County', city, mie: 80,
    lodging: [150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150, 150] });
  const xx = {
    2026: { state: 'XX', fiscalYear: 2026, standard: null, locations: [loc('9', 'Testville')] },
    2027: { state: 'XX', fiscalYear: 2027, standard: null, locations: [loc('10', 'Othertown')] }
  };
  const files = { 2026: { XX: xx[2026], CA: readJson('data/2026/CA.json') }, 2027: { XX: xx[2027], CA: readJson('data/2027/CA.json') } };
  const gap = calculateCompare({ meta, files, departIso: '2026-09-29', returnIso: '2026-10-02',
    cities: [{ state: 'CA', location: '35', stateName: 'California' }, { state: 'XX', location: '9', stateName: 'Testland' }] });
  assert.deepEqual(at(gap), ['City 2: Rates for Testville aren’t available for all of your dates.', false, 1, 'location']);
  // A duplicate wins over a rate gap in a later city (it needs no data file).
  const dup = calculateCompare({ meta, files, departIso: '2026-09-29', returnIso: '2026-10-02',
    cities: [{ state: 'CA', location: '35' }, { state: 'XX', location: '9' }, { state: 'CA', location: '35' }] });
  assert.equal(dup.error, MESSAGES.citySame(3, 1));
  // Up to 5 cities.
  assert.throws(() => calculateCompare({ meta, files: {}, departIso: '2026-10-12', returnIso: '2026-10-14',
    cities: Array.from({ length: 6 }, () => ({ state: 'CA', location: '35' })) }), /up to 5 cities/);
});

test('v1.3 compareNeeded lists only the state files the comparison reads', () => {
  const needed = (d, r, cities) => compareNeeded({ departIso: d, returnIso: r,
    cities: cities.map(([state, location]) => ({ state, location })) }, meta);
  assert.deepEqual(needed('2026-10-12', '2026-10-14', [CITY.SF, CITY.NYC, CITY.ND]), [[2027, 'CA'], [2027, 'NY'], [2027, 'ND']]);
  // Test 51 crosses 1 Oct: both years of every state.
  assert.deepEqual(needed('2026-09-29', '2026-10-02', [CITY.SF, CITY.NYC]),
    [[2026, 'CA'], [2027, 'CA'], [2026, 'NY'], [2027, 'NY']]);
  // Two cities in one state read its file once.
  assert.deepEqual(needed('2026-10-12', '2026-10-14', [CITY.SF, ['CA', 'std']]), [[2027, 'CA']]);
  // None while a check that needs no data file fails: its message wins.
  assert.deepEqual(needed('', '2026-10-14', [CITY.SF, CITY.NYC]), []);
  assert.deepEqual(needed('2026-10-12', '2026-10-14', [CITY.SF, ['NY', '']]), []);
  assert.deepEqual(needed('2026-10-12', '2026-10-14', [CITY.SF, CITY.SF]), []);
  assert.deepEqual(needed('2026-10-12', '2026-10-14', [CITY.SF]), []);
});

test('v1.3 summary line and result lines for tests 46, 48, 49 and 50', () => {
  const r46 = runCompare('2026-10-12', '2026-10-14', [CITY.SF, CITY.NYC, CITY.ND]);
  assert.equal(compareSummaryText(r46, '2026-10-12', '2026-10-14'),
    '3 cities, 12–14 Oct 2026 (3 days). Lowest: North Dakota (standard rate) at $396. Highest: New York City at $946.');
  assert.deepEqual(compareLines(r46), [
    { place: 'San Francisco', detail: 'Lodging $558 · M&IE $230', amount: 788, lowest: false },
    { place: 'New York City', detail: 'Lodging $716 · M&IE $230', amount: 946, lowest: false },
    { place: 'North Dakota (standard rate)', detail: 'Lodging $226 · M&IE $170', amount: 396, lowest: true }
  ]);
  // Two cities (test 46 with New York City removed): how much less than the other one.
  const two = runCompare('2026-10-12', '2026-10-14', [CITY.SF, CITY.ND]);
  assert.equal(compareSummaryText(two, '2026-10-12', '2026-10-14'),
    '2 cities, 12–14 Oct 2026 (3 days). Lowest: North Dakota (standard rate) at $396, $392 less than San Francisco.');
  // Test 49: tie at the lowest, named together.
  const r49 = runCompare('2026-10-12', '2026-10-14', [CITY.WI, CITY.ND, CITY.SF]);
  assert.equal(compareSummaryText(r49, '2026-10-12', '2026-10-14'),
    '3 cities, 12–14 Oct 2026 (3 days). Lowest: Wisconsin (standard rate) and North Dakota (standard rate) at $396. ' +
    'Highest: San Francisco at $788.');
  assert.deepEqual(compareLines(r49).map((l) => l.lowest), [true, true, false]);
  // Test 48: a day trip (1 day), tie at the highest.
  const r48 = runCompare('2026-10-05', '2026-10-05', [CITY.SF, CITY.NYC, CITY.PIT], true);
  assert.equal(compareSummaryText(r48, '2026-10-05', '2026-10-05'),
    '3 cities, 5 Oct 2026 (1 day). Lowest: Pittsburgh at $60. Highest: San Francisco and New York City at $69.');
  assert.deepEqual(compareLines(r48).map((l) => [l.detail, l.lowest]),
    [['Lodging $0 · M&IE $69', false], ['Lodging $0 · M&IE $69', false], ['Lodging $0 · M&IE $60', true]]);
  // Every total the same: that amount, no badge; "Both cities" for 2, "All cities" for 3 or more. Three tied
  // names join as "A, B and C".
  const same = runCompare('2026-10-05', '2026-10-05', [CITY.SF, CITY.NYC], true);
  assert.equal(compareSummaryText(same, '2026-10-05', '2026-10-05'),
    '2 cities, 5 Oct 2026 (1 day). Both cities have the same allowance: $69.');
  assert.deepEqual(compareLines(same).map((l) => l.lowest), [false, false]);
  const allSame = runCompare('2026-10-12', '2026-10-14', [CITY.WI, CITY.ND, ['IA', 'std']]);
  assert.equal(compareSummaryText(allSame, '2026-10-12', '2026-10-14'),
    '3 cities, 12–14 Oct 2026 (3 days). All cities have the same allowance: $396.');
  assert.deepEqual(compareLines(allSame).map((l) => l.lowest), [false, false, false]);
  const three = runCompare('2026-10-12', '2026-10-14', [CITY.WI, CITY.ND, ['IA', 'std'], CITY.SF]);
  assert.equal(compareSummaryText(three, '2026-10-12', '2026-10-14'),
    '4 cities, 12–14 Oct 2026 (3 days). Lowest: Wisconsin (standard rate), North Dakota (standard rate) and ' +
    'Iowa (standard rate) at $396. Highest: San Francisco at $788.');
  // Test 50: the 12-hour notice, every line $0, no badge.
  const r50 = runCompare('2026-10-05', '2026-10-05', [CITY.SF, CITY.NYC], false);
  assert.equal(compareSummaryText(r50, '2026-10-05', '2026-10-05'), MESSAGES.dayShort);
  assert.deepEqual(compareLines(r50).map((l) => [l.amount, l.lowest]), [[0, false], [0, false]]);
});

test('55. v1.2 markup, no compare hooks: everything as v1.2.0, no mode switch', () => {
  const fixture = (v) => readFileSync(new URL(`test/fixtures/03-calculator-${v}.html`, root), 'utf8');
  const v12 = fixture('v1.2');
  const v13 = fixture('v1.3');
  // perdiem.js runs Compare only with mode, compare-panel and result-compare (plus the rest below); the
  // v1.2 markup has none of the v1.3 hooks, so the switch never shows (DOM check: test/harness-v1.2.html).
  const v13Hooks = ['mode', 'calc-panel', 'compare-panel', 'cmp-depart', 'cmp-return', 'cmp-over12-wrap', 'cmp-over12',
    'cmp-list', 'cmp-template', 'cmp-add-wrap', 'cmp-add', 'cmp-add-note', 'result-calc', 'result-compare', 'cmp-results',
    'cmp-result-template'];
  v13Hooks.forEach((h) => {
    assert.ok(!v12.includes(`data-pd="${h}"`), `v1.2 fixture has no ${h}`);
    assert.ok(v13.includes(`data-pd="${h}"`), `v1.3 fixture has ${h}`);
  });
  ['data-pd-mode=', 'data-pd-city=', 'data-pd-item="badge"'].forEach((h) => assert.ok(!v12.includes(h), `v1.2 has no ${h}`));
  ['data-pd-mode="calculate"', 'data-pd-mode="compare"', 'data-pd-item="badge"'].concat(
    ['title', 'remove', 'status', 'state', 'location'].map((h) => `data-pd-city="${h}"`)).forEach((h) =>
    assert.ok(v13.includes(h), `v1.3 fixture has ${h}`));
  // v1.3 only adds: every line of the v1.2 markup (after its header comment) is in the v1.3 markup, in order,
  // and no added line carries a v1.2 hook.
  const body = (html) => html.slice(html.indexOf('-->', html.indexOf('-->') + 3) + 3).split(/\r?\n/);
  const old = body(v12);
  const added = [];
  let k = 0;
  body(v13).forEach((line) => {
    if (k < old.length && line === old[k]) k++;
    else added.push(line);
  });
  assert.equal(k, old.length, 'every v1.2 line is kept, in order');
  assert.ok(added.length > 0);
  added.forEach((line) => assert.ok(!/data-pd(-dest|-trip)?="(?!cmp-|mode|calc-panel|compare-panel|result-)/.test(line),
    'added line carries no v1.2 hook: ' + line.trim()));
  // New markup with an older script: the switch and the Compare parts carry hidden and stay hidden; the two
  // wrappers (calc-panel, result-calc) are plain divs.
  ['mode', 'compare-panel', 'result-compare'].forEach((h) =>
    assert.match(v13, new RegExp(`<div[^>]*data-pd="${h}"[^>]*\\shidden[\\s>]`), `${h} starts hidden`));
  ['calc-panel', 'result-calc'].forEach((h) =>
    assert.doesNotMatch(v13, new RegExp(`<div[^>]*data-pd="${h}"[^>]*\\shidden[\\s>]`), `${h} is not hidden`));
});

test('v1.3 CSV: a tie (test 49) and a same-day comparison with cents (test 48)', () => {
  const r49 = runCompare('2026-10-12', '2026-10-14', [CITY.WI, CITY.ND, CITY.SF]);
  assert.deepEqual(csvLines(buildCompareCsv(r49, '2026-10-12', '2026-10-14', '2026-10-16')).slice(7), [
    '"Standard rate","Wisconsin","226","157.50","12.50","396","Yes"',
    '"Standard rate","North Dakota","226","157.50","12.50","396","Yes"',
    '"San Francisco","California","558","217.50","12.50","788",""'
  ]);
  const r48 = runCompare('2026-10-05', '2026-10-05', [CITY.SF, CITY.NYC, CITY.PIT], true);
  const csv = buildCompareCsv(r48, '2026-10-05', '2026-10-05', '2026-10-16');
  assert.equal(csv.filename, 'per-diem-compare-2026-10-05-to-2026-10-05.csv');
  const lines = csvLines(csv);
  assert.deepEqual(lines.slice(1, 3), ['"Travel dates: 5 Oct 2026 (1 day)"', '"Cities: 3"']);
  assert.deepEqual(lines.slice(7), [
    '"San Francisco","California","0","65.25","3.75","69",""',
    '"New York City","New York","0","65.25","3.75","69",""',
    '"Pittsburgh","Pennsylvania","0","56.25","3.75","60","Yes"'
  ]);
});

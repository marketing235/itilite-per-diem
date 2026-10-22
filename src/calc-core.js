// Pure per diem calculation functions: no DOM, no fetch. Spec: docs/phase-4-calculator.md, extended
// by docs/v1.1.0-multi-city.md (multi-city trips, same-day rules), docs/v1.2.0-separate-trips.md
// (plans of separate trips) and docs/v1.3.0-compare-cities.md (cities side by side).
// Written as an ES module so node --test can import it; scripts/build-js.js strips the `export`
// keywords and inlines this file into the dist/perdiem.js IIFE. Keep syntax at ES2019 or older.
//
// Dates are calendar dates held as UTC day numbers (days since 1970-01-01). Never parse with
// new Date('YYYY-MM-DD') or read local-time Date methods — that shifts a day in some time zones.

const DAY_MS = 86400000;
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_DAYS = 365;

export const MAX_DESTINATIONS = 5;
export const MAX_TRIPS = 5;
export const MAX_CITIES = 5;

// k is the 1-based destination number (in the trip messages: the trip number, and j the other trip's);
// place is a placeName().
export const MESSAGES = {
  returnBeforeDepart: 'Your return date is before your departure date.',
  tooLong: 'Trips can be up to ' + MAX_DAYS + ' days.',
  locationGap: 'Rates for this location aren’t available for all of your dates.',
  chooseState: 'Choose a state',
  chooseLocation: 'Choose a city or county',
  dayShort: 'Day trips of 12 hours or less don’t qualify for per diem under GSA rules.',
  destState: function (k) { return 'Choose a state for destination ' + k + '.'; },
  destLocation: function (k) { return 'Choose a city or county for destination ' + k + '.'; },
  destArrive: function (k) { return 'Choose the date you arrive at destination ' + k + '.'; },
  destOutside: function (k) {
    return 'Destination ' + k + '’s date must be between your departure and return dates.';
  },
  destOrder: function (k) {
    return 'Destination ' + k + ' starts before destination ' + (k - 1) + '. Check the dates.';
  },
  noNight: function (place) {
    return 'No night in ' + place + '? Remove it: per diem follows where you sleep each night.';
  },
  // Destination 1 can't be removed, so point at the date that leaves it without a night.
  noNightFirst: function (place) {
    return 'No night in ' + place + '? Check destination 2’s date: per diem follows where you sleep each night.';
  },
  rateGap: function (place) { return 'Rates for ' + place + ' aren’t available for all of your dates.'; },
  // Plans of 2+ trips (v1.2 spec §4): the trip's own date messages (which: 'departure' | 'return'), and
  // the prefix for every other one.
  tripDate: function (k, which) { return 'Choose the ' + which + ' date for trip ' + k + '.'; },
  tripReturnBefore: function (k) { return 'Trip ' + k + '’s return date is before its departure date.'; },
  inTrip: function (k, text) { return 'Trip ' + k + ': ' + text; },
  tripOverlap: function (k, j) { return 'Trip ' + k + ' overlaps trip ' + j + '. Check the dates.'; },
  // Two trips sharing one boundary day: trip k starts the day trip j ends (starts true), or ends the day
  // trip j starts.
  tripTouch: function (k, j, starts) {
    return 'Trip ' + k + (starts ? ' starts the day trip ' + j + ' ends.' : ' ends the day trip ' + j + ' starts.') +
      ' For one continuous trip, use Add another destination instead.';
  },
  // Compare cities (v1.3 spec §3): the empty-date prompts (the page's v1.1 wording), the prefix for a city's
  // own messages (n is the city number, m the earlier one), the same city twice, and fewer than 2 cities.
  chooseDepart: 'Choose your departure date',
  chooseReturn: 'Choose your return date',
  inCity: function (n, text) { return 'City ' + n + ': ' + text; },
  citySame: function (n, m) { return 'City ' + n + ' is the same as city ' + m + '. Choose a different city.'; },
  addCity: 'Add another city to compare.'
};

// 'YYYY-MM-DD' → day number, or null if malformed or not a real date.
export function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2] - 1;
  const d = +m[3];
  const dt = new Date(Date.UTC(y, mo, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null;
  return dt.getTime() / DAY_MS;
}

// Day number → { year, month (0 = January), date }.
export function dayParts(day) {
  const dt = new Date(day * DAY_MS);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth(), date: dt.getUTCDate() };
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

export function toISODate(day) {
  const p = dayParts(day);
  return p.year + '-' + pad2(p.month + 1) + '-' + pad2(p.date);
}

// Fiscal year runs 1 Oct – 30 Sep: October 2026 belongs to FY2027.
export function fiscalYearOf(day) {
  const p = dayParts(day);
  return p.month >= 9 ? p.year + 1 : p.year;
}

// Fiscal years present in meta.json, plus the first and last day they cover.
export function availableRange(meta) {
  const years = Object.keys(meta.fiscalYears).map(Number).sort(function (a, b) { return a - b; });
  let min = null;
  let max = null;
  years.forEach(function (fy) {
    const e = parseISODate(meta.fiscalYears[fy].effective);
    const x = parseISODate(meta.fiscalYears[fy].expires);
    if (min === null || e < min) min = e;
    if (max === null || x > max) max = x;
  });
  return { years: years, min: min, max: max };
}

// Fiscal year the location menu is built from: the departure date's, else today's; clamped to the
// years that exist so the menu can always be filled.
export function menuFiscalYear(meta, departIso, todayIso) {
  const range = availableRange(meta);
  const day = parseISODate(departIso);
  const fy = fiscalYearOf(day !== null ? day : parseISODate(todayIso));
  if (fy < range.years[0]) return range.years[0];
  if (fy > range.years[range.years.length - 1]) return range.years[range.years.length - 1];
  return fy;
}

function monthYear(day) {
  const p = dayParts(day);
  return MONTHS_LONG[p.month] + ' ' + p.year;
}

// Both dates must already be present. Returns { ok, depart, ret, days, fiscalYears } or
// { ok: false, error, field }: field is the date to fix, 'depart' or 'return'.
export function validateDates(departIso, returnIso, meta) {
  const depart = parseISODate(departIso);
  const ret = parseISODate(returnIso);
  const bad = function (error, field) { return { ok: false, error: error, field: field }; };
  if (depart === null || ret === null) return bad('Enter dates as YYYY-MM-DD.', depart === null ? 'depart' : 'return');
  if (ret < depart) return bad(MESSAGES.returnBeforeDepart, 'return');
  const days = ret - depart + 1;
  if (days > MAX_DAYS) return bad(MESSAGES.tooLong, 'return');

  const range = availableRange(meta);
  if (depart < range.min) return bad('Rates for ' + monthYear(depart) + ' are no longer available.', 'depart');
  const fiscalYears = [];
  for (let day = depart; day <= ret; day++) {
    const fy = fiscalYearOf(day);
    if (range.years.indexOf(fy) === -1) {
      return bad('Rates for ' + monthYear(day) + ' aren’t published yet.', day === depart ? 'depart' : 'return');
    }
    if (fiscalYears.indexOf(fy) === -1) fiscalYears.push(fy);
  }
  return { ok: true, depart: depart, ret: ret, days: days, fiscalYears: fiscalYears };
}

// "Choose …" prompts are incomplete input, shown without the error style; the rest are errors.
// dest (0-based destination index, or null for the trip dates) and field ('depart' | 'return' |
// 'arrive' | 'state' | 'location') say which field the message is about, so the page can mark it.
function prompt(text, dest, field) {
  return { ok: false, error: text, incomplete: true, dest: dest, field: field };
}

function fail(text, dest, field) {
  return { ok: false, error: text, incomplete: false, dest: dest, field: field };
}

// trip: { departIso, returnIso, destinations: [{ state, location, arrive }] }, 1 to 5 in travel order.
// Runs every check that needs no data file, in form order (v1.1 spec §5). The last check, a
// destination with no night, names the place from its data file, so calculateTrip makes it.
// Returns { ok: false, error, incomplete } or { ok: true, depart, ret, days, fiscalYears, sameDay,
// starts[], nights[], needed }: starts[k] = destination k's first day, nights[k] = its nights,
// needed = the [fy, ST] state files calculateTrip will read.
export function validateTrip(trip, meta) {
  const dests = trip.destinations;
  if (!dests || dests.length < 1 || dests.length > MAX_DESTINATIONS) {
    throw new Error('validateTrip: 1 to ' + MAX_DESTINATIONS + ' destinations required');
  }
  const v = validateDates(trip.departIso, trip.returnIso, meta);
  if (!v.ok) return fail(v.error, null, v.field);
  const sameDay = v.days === 1;

  // Same-day trips ignore Arrive on: every destination starts on the departure date.
  const starts = [];
  for (let i = 0; i < dests.length; i++) {
    const k = i + 1;
    let start = v.depart;
    if (i > 0 && !sameDay) {
      start = parseISODate(dests[i].arrive);
      if (start === null) return prompt(MESSAGES.destArrive(k), i, 'arrive');
      if (start < v.depart || start > v.ret) return fail(MESSAGES.destOutside(k), i, 'arrive');
      if (start < starts[i - 1]) return fail(MESSAGES.destOrder(k), i, 'arrive');
    }
    starts.push(start);
    if (!dests[i].state) return prompt(i === 0 ? MESSAGES.chooseState : MESSAGES.destState(k), i, 'state');
    if (!dests[i].location) {
      return prompt(i === 0 ? MESSAGES.chooseLocation : MESSAGES.destLocation(k), i, 'location');
    }
  }

  const nights = [];
  const needed = [];
  const seen = {};
  starts.forEach(function (start, i) {
    const lastDest = i === starts.length - 1;
    const end = lastDest ? v.ret : starts[i + 1];
    nights.push(end - start);
    // The days this destination pays: its nights, and the return day for the last destination.
    // At least its first day, whose file gives its name.
    const lastDay = lastDest ? v.ret : Math.max(start, end - 1);
    for (let day = start; day <= lastDay; day++) {
      const fy = fiscalYearOf(day);
      const key = fy + '/' + dests[i].state;
      if (!seen[key]) {
        seen[key] = true;
        needed.push([fy, dests[i].state]);
      }
    }
  });

  return { ok: true, depart: v.depart, ret: v.ret, days: v.days, fiscalYears: v.fiscalYears,
    sameDay: sameDay, starts: starts, nights: nights, needed: needed };
}

// What each destination of an overnight trip covers, from the dates alone, so the form can show it
// under each destination title while other fields are still empty (v1.1 spec §17). arrives[k] is
// destination k's Arrive on (arrives[0] is ignored: destination 1 starts on the departure date).
// Returns one entry per destination: { startIso, endIso, nights }, or null while its dates aren't
// known or valid yet (a destination ends where the next one starts, or on the return date).
// Same-day and invalid trips: all null.
export function destinationSpans(departIso, returnIso, arrives) {
  const depart = parseISODate(departIso);
  const ret = parseISODate(returnIso);
  const out = arrives.map(function () { return null; });
  if (depart === null || ret === null || ret <= depart) return out;
  const starts = [depart];
  for (let i = 1; i < arrives.length; i++) {
    const a = parseISODate(arrives[i]);
    if (a === null || a < depart || a > ret || a < starts[i - 1]) break;
    starts.push(a);
  }
  for (let i = 0; i < starts.length; i++) {
    const end = i === arrives.length - 1 ? ret : starts[i + 1];
    if (end === undefined) break;
    out[i] = { startIso: toISODate(starts[i]), endIso: toISODate(end), nights: end - starts[i] };
  }
  return out;
}

// "12–14 Oct 2026 · 2 nights", "16 Oct 2026 · 0 nights"
export function spanText(span) {
  return formatDateRange(parseISODate(span.startIso), parseISODate(span.endIso)) + ' · ' + span.nights +
    (span.nights === 1 ? ' night' : ' nights');
}

// A trip's dates line (plans of 2+ trips, v1.2 spec §4), from the dates alone: "12–16 Oct 2026 · 5 days ·
// 2 cities", "12 Oct 2026 · day trip"; '' while either date is missing or the return is first.
// cities is the trip's number of destinations.
export function tripDatesText(departIso, returnIso, cities) {
  const d = parseISODate(departIso);
  const r = parseISODate(returnIso);
  if (d === null || r === null || r < d) return '';
  const range = formatDateRange(d, r);
  if (d === r) return range + ' · day trip';
  return range + ' · ' + (r - d + 1) + ' days · ' + cities + (cities === 1 ? ' city' : ' cities');
}

function byCity(a, b) {
  return a.city < b.city ? -1 : a.city > b.city ? 1 : 0;
}

// Location menu for one state file. value = did, or 'std' for the standard rate.
// preselect is set when there is only one choice (DC: its one location; North Dakota: std).
export function buildLocationOptions(stateData, stateName) {
  const options = stateData.locations.slice().sort(byCity).map(function (l) {
    return { value: l.did, label: l.city };
  });
  if (stateData.standard) {
    options.push({ value: 'std', label: 'All other ' + stateName + ' locations (standard rate)' });
  }
  return { options: options, preselect: options.length === 1 ? options[0].value : '' };
}

// Rate for one fiscal year's state file. A did missing from that year falls back to its standard.
function resolveRate(stateData, value) {
  if (value !== 'std') {
    for (let i = 0; i < stateData.locations.length; i++) {
      const l = stateData.locations[i];
      if (l.did === value) return { mie: l.mie, lodging: l.lodging, city: l.city, standard: false };
    }
  }
  const s = stateData.standard;
  if (!s) return null;
  return { mie: s.mie, lodging: [s.lodging, s.lodging, s.lodging, s.lodging, s.lodging, s.lodging,
    s.lodging, s.lodging, s.lodging, s.lodging, s.lodging, s.lodging], city: null, standard: true };
}

function stateFile(files, fy, st) {
  const file = files[fy] && files[fy][st];
  if (!file) throw new Error('calculateTrip: no data file for FY' + fy + ' ' + st);
  return file;
}

// Name used in messages, summaries and rows: the city from the data file (the fiscal year of the
// destination's first day, else any other loaded year), "{State} (standard rate)", or
// "destination k" while no location is chosen.
function placeName(dest, index, files, startFy) {
  const fallback = 'destination ' + (index + 1);
  if (!dest.location) return fallback;
  if (dest.location === 'std') return dest.stateName ? dest.stateName + ' (standard rate)' : 'Standard rate';
  const years = [String(startFy)].concat(Object.keys(files).sort());
  for (let i = 0; i < years.length; i++) {
    const file = i === 0 ? stateFile(files, startFy, dest.state) : files[years[i]][dest.state];
    if (!file) continue;
    for (let j = 0; j < file.locations.length; j++) {
      if (file.locations[j].did === dest.location) return file.locations[j].city;
    }
  }
  return fallback;
}

function sumRows(rows) {
  const s = { lodging: 0, mie: 0, meals: 0, incidentals: 0 };
  rows.forEach(function (r) {
    s.lodging += r.lodging;
    s.mie += r.mie;
    s.meals += r.meals;
    s.incidentals += r.incidentals;
  });
  s.total = s.lodging + s.mie;
  return s;
}

// input: { departIso, returnIso, over12, meta, files: { [fy]: { [ST]: stateData } },
//   destinations: [{ state, location: did | 'std', arrive: 'YYYY-MM-DD' | null, stateName }] }
// files must hold every pair in validateTrip(...).needed. over12 is read only on a same-day trip;
// anything but false (also a missing switch: old markup) pays the 75% day.
// Returns { ok: false, error, incomplete } or { ok: true, tripType: 'overnight' | 'day' | 'day_short',
//   days, nights, lodging, mie, meals, incidentals, total, rateUsed, notice, rows[], destinations[] }.
// rows: one per day, with the index and place of the destination whose rate applies that day.
// destinations: per-destination totals in travel order. rateUsed: index of the destination whose
// M&IE paid a same-day trip, else null. notice: the day_short message. Money is exact dollars.
export function calculateTrip(input) {
  const v = validateTrip(input, input.meta);
  if (!v.ok) return v;
  const dests = input.destinations;
  const places = dests.map(function (d, i) {
    return placeName(d, i, input.files, fiscalYearOf(v.starts[i]));
  });
  // A destination with no night: the date to fix is destination 2's for destination 1 (it can't be
  // removed), else the destination's own Arrive on.
  if (!v.sameDay) {
    for (let i = 0; i < dests.length; i++) {
      if (v.nights[i] === 0) {
        return i === 0 ? fail(MESSAGES.noNightFirst(places[0]), 1, 'arrive') : fail(MESSAGES.noNight(places[i]), i, 'arrive');
      }
    }
  }

  const fullIncidentals = input.meta.incidentals;
  const short = v.sameDay && input.over12 === false;
  const rows = [];
  let rateUsed = null;
  const rateFor = function (k, fy) {
    return resolveRate(stateFile(input.files, fy, dests[k].state), dests[k].location);
  };
  const gap = function (k) {
    const r = fail(MESSAGES.rateGap(places[k]), k, 'location');
    r.rateGap = true;
    return r;
  };
  const addRow = function (day, k, rate, edge, lodging) {
    const mie = edge ? rate.mie * 0.75 : rate.mie;
    const incidentals = edge ? fullIncidentals * 0.75 : fullIncidentals;
    rows.push({ date: toISODate(day), fiscalYear: fiscalYearOf(day), lodging: lodging,
      meals: mie - incidentals, incidentals: incidentals, mie: mie, total: lodging + mie,
      standard: rate.standard, destination: k, place: places[k] });
  };

  if (v.sameDay) {
    // One 75% day at the highest M&IE among the places visited (tie: the earliest).
    if (!short) {
      const fy = fiscalYearOf(v.depart);
      let best = null;
      for (let k = 0; k < dests.length; k++) {
        const rate = rateFor(k, fy);
        if (!rate) return gap(k);
        if (best === null || rate.mie > best.mie) {
          best = rate;
          rateUsed = k;
        }
      }
      addRow(v.depart, rateUsed, best, true, 0);
    }
  } else {
    // Night n belongs to the destination where they sleep; day n takes that night's rate. The
    // return day has no night and keeps the previous night's destination. Each day reads its own
    // fiscal year's file; only the trip's first and last day are 75%.
    let k = 0;
    for (let i = 0; i < v.days; i++) {
      const day = v.depart + i;
      const last = i === v.days - 1;
      while (!last && k < dests.length - 1 && v.starts[k + 1] <= day) k++;
      const rate = rateFor(k, fiscalYearOf(day));
      if (!rate) return gap(k);
      addRow(day, k, rate, i === 0 || last, last ? 0 : rate.lodging[dayParts(day).month]);
    }
  }

  const sum = sumRows(rows);
  const destinations = dests.map(function (d, k) {
    const own = rows.filter(function (r) { return r.destination === k; });
    const s = sumRows(own);
    return { state: d.state, location: d.location, stateName: d.stateName, place: places[k],
      startIso: toISODate(v.starts[k]), endIso: toISODate(k < dests.length - 1 ? v.starts[k + 1] : v.ret),
      nights: v.nights[k], days: own.length, lodging: s.lodging, mie: s.mie, meals: s.meals,
      incidentals: s.incidentals, total: s.total };
  });

  return { ok: true, tripType: v.sameDay ? (short ? 'day_short' : 'day') : 'overnight', days: v.days,
    nights: v.days - 1, lodging: sum.lodging, mie: sum.mie, meals: sum.meals, incidentals: sum.incidentals,
    total: sum.total, rateUsed: rateUsed, notice: short ? MESSAGES.dayShort : null, rows: rows,
    destinations: destinations };
}

// v1.0 single-destination API, kept as a thin wrapper over calculateTrip.
// input: { departIso, returnIso, meta, files: { [fy]: stateData }, location: did | 'std' }
// files must hold every fiscal year the trip touches (validateDates(...).fiscalYears).
// Returns calculateTrip's result plus city (the location's city, null for the standard rate),
// or { ok: false, error }. A same-day trip always pays the 75% day, as in v1.0.
export function calculate(input) {
  const files = {};
  Object.keys(input.files).forEach(function (fy) { files[fy] = { XX: input.files[fy] }; });
  const r = calculateTrip({ departIso: input.departIso, returnIso: input.returnIso, over12: true,
    meta: input.meta, files: files,
    destinations: [{ state: 'XX', location: input.location, arrive: null, stateName: input.stateName }] });
  if (!r.ok) return r.rateGap ? fail(MESSAGES.locationGap, 0, 'location') : r;
  const named = r.rows.some(function (row) { return !row.standard; });
  r.city = input.location !== 'std' && named ? r.destinations[0].place : null;
  return r;
}

// ---- v1.2.0: plans of separate trips (docs/v1.2.0-separate-trips.md §2, §3) ----
// plan: { meta, files, trips: [{ departIso, returnIso, over12, destinations }] }: 1 to 5 trips in the
// order entered, each a calculateTrip input without its meta and files.

// The [fy, ST] state files calculatePlan reads: each trip's, in entry order, up to the first trip that
// fails a check needing no data file (that trip's message wins, so no later trip is calculated).
export function planNeeded(plan, meta) {
  const needed = [];
  const seen = {};
  for (let t = 0; t < plan.trips.length; t++) {
    const v = validateTrip(plan.trips[t], meta);
    if (!v.ok) break;
    v.needed.forEach(function (p) {
      const key = p[0] + '/' + p[1];
      if (!seen[key]) {
        seen[key] = true;
        needed.push(p);
      }
    });
  }
  return needed;
}

// A failure is about trip t (0-based).
function onTrip(res, t) {
  res.trip = t;
  return res;
}

// Overlap check (§3.3) over [depart, return] day numbers. Each trip is checked against every trip entered
// before it, so the first clash found is the one highest on the form; the later trip in entry order is
// marked, on its departure date. Two trips sharing only a boundary day get the message for that direction.
function overlapError(spans) {
  for (let k = 1; k < spans.length; k++) {
    for (let j = 0; j < k; j++) {
      const a = spans[k];
      const b = spans[j];
      if (a[0] <= b[1] && b[0] <= a[1]) {
        const text = a[0] === b[1] || a[1] === b[0] ? MESSAGES.tripTouch(k + 1, j + 1, a[0] === b[1])
          : MESSAGES.tripOverlap(k + 1, j + 1);
        return onTrip(fail(text, null, 'depart'), k);
      }
    }
  }
  return null;
}

// Each trip is calculated on its own with calculateTrip (its own 75% first and last day; nothing carries
// across trips); then no two trips may share a day. Checks run trip by trip in entry order, each in full
// (v1.1 order), then the overlap check; the first failure wins. With 2+ trips every message names its
// trip; a lone trip keeps the v1.1 wording, and its empty dates stay the page's to word.
// files must hold planNeeded(plan, meta).
// Returns { ok: false, error, incomplete, trip, dest, field } or { ok: true, trips[], days, lodging, mie,
// meals, incidentals, total, rows[] }: trips are the calculateTrip results in entry order, each with its
// departIso and returnIso; the plan totals are their exact sums; rows are theirs in order, each with trip.
export function calculatePlan(plan) {
  const trips = plan.trips;
  if (!trips || trips.length < 1 || trips.length > MAX_TRIPS) {
    throw new Error('calculatePlan: 1 to ' + MAX_TRIPS + ' trips required');
  }
  const several = trips.length > 1;
  const out = { ok: true, trips: [], days: 0, lodging: 0, mie: 0, meals: 0, incidentals: 0, total: 0, rows: [] };
  const spans = [];
  for (let t = 0; t < trips.length; t++) {
    const trip = trips[t];
    if (several && !trip.departIso) return onTrip(prompt(MESSAGES.tripDate(t + 1, 'departure'), null, 'depart'), t);
    if (several && !trip.returnIso) return onTrip(prompt(MESSAGES.tripDate(t + 1, 'return'), null, 'return'), t);
    const r = calculateTrip({ departIso: trip.departIso, returnIso: trip.returnIso, over12: trip.over12,
      meta: plan.meta, files: plan.files, destinations: trip.destinations });
    if (!r.ok) {
      if (several) {
        r.error = r.error === MESSAGES.returnBeforeDepart ? MESSAGES.tripReturnBefore(t + 1)
          : MESSAGES.inTrip(t + 1, r.error);
      }
      return onTrip(r, t);
    }
    r.departIso = trip.departIso;
    r.returnIso = trip.returnIso;
    out.trips.push(r);
    spans.push([parseISODate(trip.departIso), parseISODate(trip.returnIso)]);
  }
  const clash = overlapError(spans);
  if (clash) return clash;
  out.trips.forEach(function (r, t) {
    ['days', 'lodging', 'mie', 'meals', 'incidentals', 'total'].forEach(function (k) { out[k] += r[k]; });
    r.rows.forEach(function (row) { out.rows.push(Object.assign({ trip: t }, row)); });
  });
  return out;
}

// ---- v1.3.0: Compare cities (docs/v1.3.0-compare-cities.md §2, §3) ----
// comparison: { meta, files, departIso, returnIso, over12, cities: [{ state, location, stateName }] }: up to
// 5 cities in the order entered, each one destination of a trip on the shared dates and switch.

// A city as a calculateTrip input.
function cityTrip(cmp, city) {
  return { departIso: cmp.departIso, returnIso: cmp.returnIso, over12: cmp.over12, meta: cmp.meta,
    files: cmp.files, destinations: [{ state: city.state, location: city.location, arrive: null,
      stateName: city.stateName }] };
}

// A message about city i (0-based; null for the dates or the whole comparison) and its field.
function cityFail(text, incomplete, i, field) {
  return { ok: false, error: text, incomplete: incomplete, city: i, field: field };
}

// The checks that need no data file (§3 steps 1 to 4), in order: the first failure, or null.
function compareCheck(cmp, meta) {
  const cities = cmp.cities;
  if (!cities || cities.length > MAX_CITIES) throw new Error('calculateCompare: up to ' + MAX_CITIES + ' cities');
  if (!cmp.departIso) return cityFail(MESSAGES.chooseDepart, true, null, 'depart');
  if (!cmp.returnIso) return cityFail(MESSAGES.chooseReturn, true, null, 'return');
  const v = validateDates(cmp.departIso, cmp.returnIso, meta);
  if (!v.ok) return cityFail(v.error, false, null, v.field);
  for (let i = 0; i < cities.length; i++) {
    if (!cities[i].state) return cityFail(MESSAGES.inCity(i + 1, MESSAGES.chooseState), true, i, 'state');
    if (!cities[i].location) return cityFail(MESSAGES.inCity(i + 1, MESSAGES.chooseLocation), true, i, 'location');
  }
  // Each city against the cities entered before it; the later one is marked.
  for (let k = 1; k < cities.length; k++) {
    for (let j = 0; j < k; j++) {
      if (cities[k].state === cities[j].state && cities[k].location === cities[j].location) {
        return cityFail(MESSAGES.citySame(k + 1, j + 1), false, k, 'location');
      }
    }
  }
  if (cities.length < 2) return cityFail(MESSAGES.addCity, true, null, null);
  return null;
}

// The [fy, ST] state files calculateCompare reads: every city's, or none while a check that needs no data
// file fails (its message wins).
export function compareNeeded(cmp, meta) {
  if (compareCheck(cmp, meta)) return [];
  return planNeeded({ trips: cmp.cities.map(function (c) { return cityTrip(cmp, c); }) }, meta);
}

// Each city is calculated on its own with calculateTrip: its own 75% first and last day, fiscal years,
// standard-rate fallback and rate-gap check. Checks in §3 order, first failure wins: the dates (v1.1
// messages), each city's State then City ("City n: " prompts), the same city twice, fewer than 2 cities,
// then each city's own calculation ("City n: " errors). Nothing is added up.
// files must hold compareNeeded(comparison, meta).
// Returns { ok: false, error, incomplete, city, field } or { ok: true, days, tripType, cities[], lowest[],
// highest[] }: cities are the calculateTrip results in entry order; lowest and highest are the indexes of the
// cities at the lowest and highest total, compared in cents, both empty when every total is the same.
export function calculateCompare(cmp) {
  const bad = compareCheck(cmp, cmp.meta);
  if (bad) return bad;
  const cities = [];
  for (let i = 0; i < cmp.cities.length; i++) {
    const r = calculateTrip(cityTrip(cmp, cmp.cities[i]));
    if (!r.ok) return cityFail(MESSAGES.inCity(i + 1, r.error), r.incomplete, i, r.field);
    cities.push(r);
  }
  const cents = cities.map(function (r) { return Math.round(r.total * 100); });
  const min = Math.min.apply(null, cents);
  const max = Math.max.apply(null, cents);
  const at = function (value) {
    const out = [];
    cents.forEach(function (c, i) { if (min !== max && c === value) out.push(i); });
    return out;
  };
  return { ok: true, days: cities[0].days, tripType: cities[0].tripType, cities: cities, lowest: at(min),
    highest: at(max) };
}

// GA4 location_type: 'mixed' when a trip has both standard-rate and city destinations.
export function locationType(destinations) {
  let std = false;
  let nsa = false;
  destinations.forEach(function (d) {
    if (d.location === 'std') std = true;
    else nsa = true;
  });
  return std && nsa ? 'mixed' : std ? 'standard' : 'nsa';
}

let wholeFmt = null;
let centsFmt = null;

// $788, $1,207, $55.50 — cents only when the amount isn't a whole dollar.
export function formatMoney(n) {
  if (!wholeFmt) {
    wholeFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD',
      minimumFractionDigits: 0, maximumFractionDigits: 0 });
    centsFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  }
  return (Number.isInteger(n) ? wholeFmt : centsFmt).format(n);
}

// 5 Oct 2026 · 1–3 Oct 2026 · 29 Sep – 2 Oct 2026 · 30 Dec 2026 – 2 Jan 2027
export function formatDateRange(depart, ret) {
  const a = dayParts(depart);
  const b = dayParts(ret);
  const end = b.date + ' ' + MONTHS_SHORT[b.month] + ' ' + b.year;
  if (depart === ret) return end;
  if (a.year === b.year && a.month === b.month) return a.date + '–' + end;
  if (a.year === b.year) return a.date + ' ' + MONTHS_SHORT[a.month] + ' – ' + end;
  return a.date + ' ' + MONTHS_SHORT[a.month] + ' ' + a.year + ' – ' + end;
}

// "3 days in San Francisco, 1–3 Oct 2026. Total allowance $788."
// note (optional) is a sentence placed before the total.
export function summaryText(result, place, departIso, returnIso, note) {
  return result.days + (result.days === 1 ? ' day' : ' days') + ' in ' + place + ', ' +
    formatDateRange(parseISODate(departIso), parseISODate(returnIso)) + '. ' + (note ? note + ' ' : '') +
    'Total allowance ' + formatMoney(result.total) + '.';
}

// "A", "A and B", "A, B and C".
function joinNames(names) {
  return names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

// A trip's places in travel order.
function placeList(result) {
  return joinNames(result.destinations.map(function (d) { return d.place; }));
}

// "12–14 Oct 2026 (3 days)", "5 Oct 2026 (1 day)"
function datesAndDays(departIso, returnIso, days) {
  return formatDateRange(parseISODate(departIso), parseISODate(returnIso)) + ' (' + days +
    (days === 1 ? ' day)' : ' days)');
}

// Summary for a calculateTrip result: its places in travel order. A same-day trip to several places
// names the one whose rate applies. day_short gives its notice.
export function tripSummaryText(result, departIso, returnIso) {
  if (result.notice) return result.notice;
  let note = '';
  if (result.rateUsed !== null && result.destinations.length > 1) {
    const used = result.destinations[result.rateUsed];
    note = (used.location === 'std' ? 'The ' + used.stateName + ' standard rate' : used.place + '’s rate') +
      ' applies (the highest).';
  }
  return summaryText(result, placeList(result), departIso, returnIso, note);
}

function tripRange(r) {
  return formatDateRange(parseISODate(r.departIso), parseISODate(r.returnIso));
}

// Earliest departure and latest return across a plan's trips, as ISO dates.
function planSpan(plan) {
  let first = null;
  let last = null;
  plan.trips.forEach(function (r) {
    if (first === null || r.departIso < first) first = r.departIso;
    if (last === null || r.returnIso > last) last = r.returnIso;
  });
  return [first, last];
}

// Every trip is a day trip of 12 hours or less: the plan is valid, at $0, with nothing to export.
export function allShort(plan) {
  return plan.trips.every(function (r) { return r.tripType === 'day_short'; });
}

// Summary for a calculatePlan result with 2+ trips (v1.2 spec §4). Two trips: each named by its first
// destination (plus "and {n} more" for several) with its dates; three or more: the overall dates. A plan
// of day trips of 12 hours or less only gives their notice, as one such trip does.
export function planSummaryText(plan) {
  if (allShort(plan)) return MESSAGES.dayShort;
  const span = planSpan(plan);
  const which = plan.trips.length === 2 ? ': ' + plan.trips.map(function (r) {
    const more = r.destinations.length - 1;
    return r.destinations[0].place + (more ? ' and ' + more + ' more' : '') + ' (' + tripRange(r) + ')';
  }).join(' and ') : ', ' + formatDateRange(parseISODate(span[0]), parseISODate(span[1]));
  return plan.trips.length + ' trips, ' + plan.days + ' days' + which + '. Total allowance ' +
    formatMoney(plan.total) + '.';
}

// Result breakdown lines { place, dates, amount, sub } (v1.1 §17, v1.2 §4). A calculateTrip result: one
// per destination of an overnight trip with 2+ destinations, else none. A calculatePlan result: one per
// trip in entry order ("Trip 1: New York City and Pittsburgh", its dates line, its total), each followed
// by its own destination lines (sub). The lines that aren't sub add up to the total.
export function breakdownLines(res) {
  const dests = function (r, sub) {
    return r.tripType === 'overnight' && r.destinations.length > 1 ? r.destinations.map(function (d) {
      return { place: d.place, dates: spanText(d), amount: d.total, sub: sub };
    }) : [];
  };
  if (!res.trips) return dests(res, false);
  let lines = [];
  res.trips.forEach(function (r, t) {
    lines.push({ place: 'Trip ' + (t + 1) + ': ' + placeList(r), amount: r.total, sub: false,
      dates: tripDatesText(r.departIso, r.returnIso, r.destinations.length) });
    lines = lines.concat(dests(r, true));
  });
  return lines;
}

// Summary for a calculateCompare result (v1.3 spec §5): the number of cities and the dates, then the lowest
// city or cities and, with 3+ cities, the highest; with 2 cities, how much less than the other one. Cities
// tied at the lowest or the highest are named together. Every total the same: that amount ("Both cities"
// for 2, "All cities" for 3 or more). A day trip of 12 hours or less (every city $0): its notice.
export function compareSummaryText(cmp, departIso, returnIso) {
  if (cmp.tripType === 'day_short') return MESSAGES.dayShort;
  const cities = cmp.cities;
  const head = cities.length + ' cities, ' + datesAndDays(departIso, returnIso, cmp.days) + '. ';
  if (!cmp.lowest.length) {
    return head + (cities.length === 2 ? 'Both' : 'All') + ' cities have the same allowance: ' +
      formatMoney(cities[0].total) + '.';
  }
  const total = function (idx) { return cities[idx[0]].total; };
  const names = function (idx) {
    return joinNames(idx.map(function (i) { return cities[i].destinations[0].place; }));
  };
  const lowest = 'Lowest: ' + names(cmp.lowest) + ' at ' + formatMoney(total(cmp.lowest));
  if (cities.length === 2) {
    return head + lowest + ', ' + formatMoney(total(cmp.highest) - total(cmp.lowest)) + ' less than ' +
      names(cmp.highest) + '.';
  }
  return head + lowest + '. Highest: ' + names(cmp.highest) + ' at ' + formatMoney(total(cmp.highest)) + '.';
}

// Compare result lines (v1.3 spec §5), one per city in entry order: { place, detail, amount, lowest }, where
// detail is "Lodging $226 · M&IE $170" and lowest marks the city or cities that get the Lowest badge.
export function compareLines(cmp) {
  return cmp.cities.map(function (r, i) {
    return { place: r.destinations[0].place, detail: 'Lodging ' + formatMoney(r.lodging) + ' · M&IE ' +
      formatMoney(r.mie), amount: r.total, lowest: cmp.lowest.indexOf(i) !== -1 };
  });
}

// GA4 params for perdiem_calculate and perdiem_export (v1.1 spec §9): codes and counts only, never
// dates, place names or anything typed.
export function analyticsParams(result) {
  return { state: result.destinations[0].state, location_type: locationType(result.destinations),
    days: result.days, destinations: result.destinations.length, trip_type: result.tripType };
}

// The same for a plan (v1.2 spec §7), across every destination of every trip, plus trips (1 to 5).
// plan: a calculatePlan result, or { trips: [calculateTrip result], days } for one trip.
export function planAnalyticsParams(plan) {
  let dests = [];
  let type = null;
  plan.trips.forEach(function (r) {
    dests = dests.concat(r.destinations);
    type = type === null || type === r.tripType ? r.tripType : 'mixed';
  });
  const p = analyticsParams({ destinations: dests, days: plan.days, tripType: type });
  p.trips = plan.trips.length;
  return p;
}

// GA4 params for perdiem_compare (v1.3 spec §8): city 1's state, the number of cities (2 to 5), days,
// trip_type, and location_type across the cities. Codes and counts only.
export function compareAnalyticsParams(cmp) {
  const dests = cmp.cities.map(function (r) { return r.destinations[0]; });
  return { state: dests[0].state, cities: dests.length, days: cmp.days, trip_type: cmp.tripType,
    location_type: locationType(dests) };
}

// Quoted, quotes doubled; a leading = + - @ (or tab/CR) gets a ' so Excel treats it as text.
function csvCell(value) {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// Plain numbers for Excel in any locale: 279, 65.25 (never $ or thousands separators).
function csvNumber(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// A destination as the export names it: "New York City, New York" or "Standard rate, New York".
function csvPlace(d) {
  return (d.location === 'std' ? 'Standard rate' : d.place) + ', ' + d.stateName;
}

const CSV_SOURCE = ['Source: U.S. General Services Administration per diem rates'];
const CSV_COLUMNS = ['Date', 'Fiscal year', 'Location', 'Lodging (USD)', 'Meals (USD)', 'Incidentals (USD)',
  'Day total (USD)'];

// A trip's destinations with their dates: "New York City, New York (12–14 Oct 2026); Pittsburgh, …".
function csvPlaces(result) {
  return result.destinations.map(function (d) {
    return csvPlace(d) + ' (' + formatDateRange(parseISODate(d.startIso), parseISODate(d.endIso)) + ')';
  }).join('; ');
}

// A same-day trip to several places names the place whose rate it pays; any other trip: null.
function csvRateUsed(result) {
  if (result.destinations.length < 2 || result.rateUsed === null) return null;
  const used = result.destinations[result.rateUsed];
  return 'Same-day trip, away more than 12 hours. Rate used: ' +
    (used.location === 'std' ? used.stateName + ' standard rate' : used.place) + ' (the highest of your stops).';
}

// A trip's day rows, each naming the destination it belongs to; on an overnight trip with 2+
// destinations, a subtotal row after each destination's last day.
function csvDays(result, lines) {
  const n = csvNumber;
  const dests = result.destinations;
  const subtotals = dests.length > 1 && result.tripType === 'overnight';
  result.rows.forEach(function (row, i) {
    lines.push([row.date, 'FY' + row.fiscalYear, csvPlace(dests[row.destination]),
      i < result.nights ? n(row.lodging) : '', n(row.meals), n(row.incidentals), n(row.total)]);
    const next = result.rows[i + 1];
    if (subtotals && (!next || next.destination !== row.destination)) {
      const d = dests[row.destination];
      lines.push(['Subtotal: ' + d.place, '', '', n(d.lodging), n(d.meals), n(d.incidentals), n(d.total)]);
    }
  });
}

function csvTotal(label, r) {
  const n = csvNumber;
  return [label, '', '', n(r.lodging), n(r.meals), n(r.incidentals), n(r.total)];
}

// UTF-8 BOM, every cell quoted, CRLF after every line.
function csvText(lines) {
  return '﻿' + lines.map(function (cells) { return cells.map(csvCell).join(','); }).join('\r\n') + '\r\n';
}

// CSV export of a calculateTrip result (phase-4 spec "Export", v1.1 spec §8). todayIso is the
// Generated date. Each day row names the destination it belongs to; an overnight trip with 2+
// destinations gets a subtotal row after each destination's last day. A same-day trip to several
// places adds the rate-used line instead (it has one day row, so no subtotals).
// Returns { filename, text }: text starts with the UTF-8 BOM and ends every line with CRLF.
export function buildCsv(result, departIso, returnIso, todayIso) {
  const dests = result.destinations;
  const multi = dests.length > 1;
  const today = parseISODate(todayIso);
  const lines = [['ITILITE per diem estimate'], [multi ? 'Trip: ' + csvPlaces(result) : csvPlace(dests[0])]];
  const rateUsed = csvRateUsed(result);
  if (rateUsed) lines.push([rateUsed]);
  lines.push(['Travel dates: ' + datesAndDays(departIso, returnIso, result.days)],
    CSV_SOURCE, ['Generated ' + formatDateRange(today, today)], [], CSV_COLUMNS);
  csvDays(result, lines);
  lines.push(csvTotal('Total', result));
  return {
    filename: 'per-diem-' + (multi ? 'multi-city' : dests[0].state.toLowerCase()) + '-' + departIso + '-to-' +
      returnIso + '.csv',
    text: csvText(lines)
  };
}

// CSV export of a calculatePlan result with 2+ trips (v1.2 spec §6). Header: the number of trips, then
// one line per trip with its destinations and dates (and a same-day trip's rate-used line). Rows: per
// trip in entry order, a "Trip k" title row, its day rows (with destination subtotals) and a
// "Subtotal: Trip k" row; then the Total. A day trip of 12 hours or less has one zero row with the note
// in its Location cell. Same cells, quoting, BOM and CRLF as buildCsv.
export function buildPlanCsv(plan, todayIso) {
  const today = parseISODate(todayIso);
  const span = planSpan(plan);
  const lines = [['ITILITE per diem estimate'], ['Trips: ' + plan.trips.length]];
  plan.trips.forEach(function (r, t) {
    lines.push(['Trip ' + (t + 1) + ': ' + csvPlaces(r)]);
    const rateUsed = csvRateUsed(r);
    if (rateUsed) lines.push([rateUsed]);
  });
  lines.push(CSV_SOURCE, ['Generated ' + formatDateRange(today, today)], [], CSV_COLUMNS);
  plan.trips.forEach(function (r, t) {
    const name = 'Trip ' + (t + 1);
    lines.push([name]);
    if (r.tripType === 'day_short') {
      lines.push([r.departIso, 'FY' + fiscalYearOf(parseISODate(r.departIso)),
        'Day trip of 12 hours or less: no per diem', '', '0', '0', '0']);
    } else {
      csvDays(r, lines);
    }
    lines.push(csvTotal('Subtotal: ' + name, r));
  });
  lines.push(csvTotal('Total', plan));
  return { filename: 'per-diem-trips-' + span[0] + '-to-' + span[1] + '.csv', text: csvText(lines) };
}

const CSV_COMPARE_COLUMNS = ['City', 'State', 'Lodging (USD)', 'Meals (USD)', 'Incidentals (USD)', 'Total (USD)',
  'Lowest'];

// CSV export of a calculateCompare result (v1.3 spec §7). Header: the dates and the number of cities. Rows:
// one per city in entry order with its totals, City and State named as in v1.1 ("Standard rate", "North
// Dakota"), and Lowest "Yes" for the lowest city or cities. No daily rows, no total row. Same cells,
// quoting, BOM and CRLF as buildCsv.
export function buildCompareCsv(cmp, departIso, returnIso, todayIso) {
  const n = csvNumber;
  const today = parseISODate(todayIso);
  const lines = [['ITILITE per diem comparison'], ['Travel dates: ' + datesAndDays(departIso, returnIso, cmp.days)],
    ['Cities: ' + cmp.cities.length], CSV_SOURCE, ['Generated ' + formatDateRange(today, today)], [],
    CSV_COMPARE_COLUMNS];
  cmp.cities.forEach(function (r, i) {
    const d = r.destinations[0];
    lines.push([d.location === 'std' ? 'Standard rate' : d.place, d.stateName, n(r.lodging), n(r.meals),
      n(r.incidentals), n(r.total), cmp.lowest.indexOf(i) !== -1 ? 'Yes' : '']);
  });
  return { filename: 'per-diem-compare-' + departIso + '-to-' + returnIso + '.csv', text: csvText(lines) };
}

/*! ITILITE per diem calculator | built from src/ by scripts/build-js.js, do not edit */
(function () {
'use strict';

// ---- src/calc-core.js ----
// Pure per diem calculation functions: no DOM, no fetch. Spec: docs/phase-4-calculator.md, extended
// by docs/v1.1.0-multi-city.md (multi-city trips, same-day rules).
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

const MAX_DESTINATIONS = 5;

// k is the 1-based destination number; place is a placeName().
const MESSAGES = {
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
  rateGap: function (place) { return 'Rates for ' + place + ' aren’t available for all of your dates.'; }
};

// 'YYYY-MM-DD' → day number, or null if malformed or not a real date.
function parseISODate(s) {
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
function dayParts(day) {
  const dt = new Date(day * DAY_MS);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth(), date: dt.getUTCDate() };
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function toISODate(day) {
  const p = dayParts(day);
  return p.year + '-' + pad2(p.month + 1) + '-' + pad2(p.date);
}

// Fiscal year runs 1 Oct – 30 Sep: October 2026 belongs to FY2027.
function fiscalYearOf(day) {
  const p = dayParts(day);
  return p.month >= 9 ? p.year + 1 : p.year;
}

// Fiscal years present in meta.json, plus the first and last day they cover.
function availableRange(meta) {
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
function menuFiscalYear(meta, departIso, todayIso) {
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
function validateDates(departIso, returnIso, meta) {
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
function validateTrip(trip, meta) {
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
function destinationSpans(departIso, returnIso, arrives) {
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
function spanText(span) {
  return formatDateRange(parseISODate(span.startIso), parseISODate(span.endIso)) + ' · ' + span.nights +
    (span.nights === 1 ? ' night' : ' nights');
}

function byCity(a, b) {
  return a.city < b.city ? -1 : a.city > b.city ? 1 : 0;
}

// Location menu for one state file. value = did, or 'std' for the standard rate.
// preselect is set when there is only one choice (DC: its one location; North Dakota: std).
function buildLocationOptions(stateData, stateName) {
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
function calculateTrip(input) {
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
function calculate(input) {
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

// GA4 location_type: 'mixed' when a trip has both standard-rate and city destinations.
function locationType(destinations) {
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
function formatMoney(n) {
  if (!wholeFmt) {
    wholeFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD',
      minimumFractionDigits: 0, maximumFractionDigits: 0 });
    centsFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  }
  return (Number.isInteger(n) ? wholeFmt : centsFmt).format(n);
}

// 5 Oct 2026 · 1–3 Oct 2026 · 29 Sep – 2 Oct 2026 · 30 Dec 2026 – 2 Jan 2027
function formatDateRange(depart, ret) {
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
function summaryText(result, place, departIso, returnIso, note) {
  return result.days + (result.days === 1 ? ' day' : ' days') + ' in ' + place + ', ' +
    formatDateRange(parseISODate(departIso), parseISODate(returnIso)) + '. ' + (note ? note + ' ' : '') +
    'Total allowance ' + formatMoney(result.total) + '.';
}

// Summary for a calculateTrip result: places in travel order ("A", "A and B", "A, B and C"). A
// same-day trip to several places names the one whose rate applies. day_short gives its notice.
function tripSummaryText(result, departIso, returnIso) {
  if (result.notice) return result.notice;
  const places = result.destinations.map(function (d) { return d.place; });
  const list = places.length === 1 ? places[0]
    : places.slice(0, -1).join(', ') + ' and ' + places[places.length - 1];
  let note = '';
  if (result.rateUsed !== null && places.length > 1) {
    const used = result.destinations[result.rateUsed];
    note = (used.location === 'std' ? 'The ' + used.stateName + ' standard rate' : used.place + '’s rate') +
      ' applies (the highest).';
  }
  return summaryText(result, list, departIso, returnIso, note);
}

// GA4 params for perdiem_calculate and perdiem_export (v1.1 spec §9): codes and counts only, never
// dates, place names or anything typed.
function analyticsParams(result) {
  return { state: result.destinations[0].state, location_type: locationType(result.destinations),
    days: result.days, destinations: result.destinations.length, trip_type: result.tripType };
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

// CSV export of a calculateTrip result (phase-4 spec "Export", v1.1 spec §8). todayIso is the
// Generated date. Each day row names the destination it belongs to; an overnight trip with 2+
// destinations gets a subtotal row after each destination's last day. A same-day trip to several
// places adds the rate-used line instead (it has one day row, so no subtotals).
// Returns { filename, text }: text starts with the UTF-8 BOM and ends every line with CRLF.
function buildCsv(result, departIso, returnIso, todayIso) {
  const n = csvNumber;
  const dests = result.destinations;
  const multi = dests.length > 1;
  const today = parseISODate(todayIso);
  const lines = [['ITILITE per diem estimate'], [multi ? 'Trip: ' + dests.map(function (d) {
    return csvPlace(d) + ' (' + formatDateRange(parseISODate(d.startIso), parseISODate(d.endIso)) + ')';
  }).join('; ') : csvPlace(dests[0])]];
  if (multi && result.rateUsed !== null) {
    const used = dests[result.rateUsed];
    lines.push(['Same-day trip, away more than 12 hours. Rate used: ' +
      (used.location === 'std' ? used.stateName + ' standard rate' : used.place) + ' (the highest of your stops).']);
  }
  lines.push(['Travel dates: ' + formatDateRange(parseISODate(departIso), parseISODate(returnIso)) +
    ' (' + result.days + (result.days === 1 ? ' day)' : ' days)')],
  ['Source: U.S. General Services Administration per diem rates'],
  ['Generated ' + formatDateRange(today, today)],
  [],
  ['Date', 'Fiscal year', 'Location', 'Lodging (USD)', 'Meals (USD)', 'Incidentals (USD)', 'Day total (USD)']);
  const subtotals = multi && result.tripType === 'overnight';
  result.rows.forEach(function (row, i) {
    lines.push([row.date, 'FY' + row.fiscalYear, csvPlace(dests[row.destination]),
      i < result.nights ? n(row.lodging) : '', n(row.meals), n(row.incidentals), n(row.total)]);
    const next = result.rows[i + 1];
    if (subtotals && (!next || next.destination !== row.destination)) {
      const d = dests[row.destination];
      lines.push(['Subtotal: ' + d.place, '', '', n(d.lodging), n(d.meals), n(d.incidentals), n(d.total)]);
    }
  });
  lines.push(['Total', '', '', n(result.lodging), n(result.meals), n(result.incidentals), n(result.total)]);
  return {
    filename: 'per-diem-' + (multi ? 'multi-city' : dests[0].state.toLowerCase()) + '-' + departIso + '-to-' +
      returnIso + '.csv',
    text: '﻿' + lines.map(function (cells) { return cells.map(csvCell).join(','); }).join('\r\n') + '\r\n'
  };
}

// ---- src/perdiem.js ----
// DOM wiring for the per diem calculator. Spec: docs/phase-4-calculator.md, extended by
// docs/v1.1.0-multi-city.md (multi-city rows, same-day switch).
// Adds behaviour to the existing Webflow markup (data-pd hooks) — never adds layout or styles, apart
// from cloning the v1.1 templates: destination rows and result breakdown lines (spec §7, §17).
// Only runs as part of dist/perdiem.js: scripts/build-js.js drops the import below and inlines
// calc-core.js into the same IIFE. Keep syntax at ES2019 or older.


// Must be read while the script first executes; it is null inside later callbacks.
const SCRIPT = document.currentScript;
const FALLBACK_BASE = 'https://cdn.jsdelivr.net/gh/marketing235/itilite-per-diem@v1.1.0/';
const HOOKS = ['depart', 'return', 'state', 'location', 'message', 'export', 'days', 'total',
  'lodging', 'meals', 'incidentals'];
// v1.1 hooks, all optional (spec §7). Without dest-list, dest-template and add the calculator keeps one
// destination, as v1.0.1; without over12 a same-day trip pays the 75% day.
const V11_HOOKS = { over12: 'over12', over12Wrap: 'over12-wrap', title1: 'dest1-title', list: 'dest-list',
  tpl: 'dest-template', addWrap: 'add-wrap', add: 'add', addNote: 'add-note', status1: 'dest1-status',
  breakdown: 'breakdown', breakdownList: 'breakdown-list', breakdownTpl: 'breakdown-template' };
// data-pd-dest hooks inside one template row ("status" is optional: the row's dates or its error).
const ROW_HOOKS = { title: 'title', remove: 'remove', arriveField: 'arrive-field', arrive: 'arrive',
  state: 'state', location: 'location' };
// data-pd-item hooks inside one result breakdown line.
const ITEM_HOOKS = ['place', 'dates', 'amount'];
const LOAD_ERROR = 'Rates couldn’t load. Please try again.';

// Repo root at the same tag as this script: …/itilite-per-diem@v1.0.0/dist/perdiem.min.js → …@v1.0.0/
function dataBase() {
  const src = SCRIPT && SCRIPT.src;
  const m = src ? /^(.*\/)dist\/[^/]*$/.exec(src.split(/[?#]/)[0]) : null;
  return m ? m[1] : FALLBACK_BASE;
}
const BASE = dataBase();
const META_URL = BASE + 'data/meta.json';

// One fetch per file per page view; a failed fetch is forgotten so the next field change retries.
const cache = {};
function load(url) {
  let entry = cache[url];
  if (!entry) {
    entry = cache[url] = {};
    entry.promise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
        return res.json();
      })
      .then((data) => { entry.data = data; return data; },
        (err) => { delete cache[url]; throw err; });
  }
  return entry.promise;
}
const loaded = (url) => cache[url] && cache[url].data;
const stateUrl = (fy, st) => BASE + 'data/' + fy + '/' + st + '.json';

// The visitor's calendar date (local time on purpose: it is their "today").
function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function track(name, params) {
  try {
    if (typeof window.gtag === 'function') window.gtag('event', name, params);
  } catch (e) { /* analytics must never break the calculator */ }
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// The hooks of one template row, or null if any is missing.
function rowHooks(row) {
  const x = { row: row };
  const names = Object.keys(ROW_HOOKS);
  for (let i = 0; i < names.length; i++) {
    x[names[i]] = row.querySelector('[data-pd-dest="' + ROW_HOOKS[names[i]] + '"]');
    if (!x[names[i]]) return null;
  }
  x.status = row.querySelector('[data-pd-dest="status"]');
  return x;
}

// A destination: its State and City or county selects (destination 1: the v1.0 hooks, arrive null;
// k >= 2: a template row) plus the state of its location menu.
function newDest(x) {
  x.menuKey = x.wantMenu = null;
  x.menuState = x.selected = '';
  return x;
}

function init(root) {
  const q = (name) => root.querySelector('[data-pd="' + name + '"]');
  const e = {};
  for (let i = 0; i < HOOKS.length; i++) {
    e[HOOKS[i]] = q(HOOKS[i]);
    if (!e[HOOKS[i]]) {
      console.warn('[perdiem] missing hook data-pd="' + HOOKS[i] + '"; calculator not started');
      return;
    }
  }
  Object.keys(V11_HOOKS).forEach((k) => { e[k] = q(V11_HOOKS[k]); });
  const parts = [e.list, e.tpl, e.add].filter(Boolean).length;
  const row = parts === 3 && e.tpl.content && e.tpl.content.firstElementChild;
  const multi = !!(row && rowHooks(row));
  if (parts && !multi) {
    console.warn('[perdiem] incomplete destination markup (dest-list, dest-template, add, data-pd-dest); ' +
      'running with one destination');
  }

  // Per-destination breakdown in the result: its list and a line template with every item hook.
  const line = e.breakdown && e.breakdownList && e.breakdownTpl && e.breakdownTpl.content &&
    e.breakdownTpl.content.firstElementChild;
  const items = line && ITEM_HOOKS.every((n) => line.querySelector('[data-pd-item="' + n + '"]'));

  const pre = (root.getAttribute('data-state') || '').trim().toUpperCase();
  const c = {
    e: e, pre: pre, initial: e.message.textContent, seq: 0, active: false, range: null, err: null,
    line: items ? line : null,
    dests: [newDest({ state: e.state, location: e.location, arrive: null })], result: null, timer: 0, fired: {}
  };
  if (pre && Array.prototype.some.call(e.state.options, (o) => o.value === pre)) e.state.value = pre;

  const onChange = () => update(c);
  ['input', 'change'].forEach((type) => {
    e.depart.addEventListener(type, onChange);
    e.return.addEventListener(type, onChange);
  });
  openPickerOnClick(e.depart);
  openPickerOnClick(e.return);
  wireDest(c, c.dests[0]);
  if (e.over12) e.over12.addEventListener('change', onChange);
  e.export.addEventListener('click', () => exportCsv(c));
  if (multi) {
    e.add.addEventListener('click', () => addDest(c));
    if (e.addWrap) e.addWrap.hidden = false;
  }

  // Lazy start: nothing is fetched until the card is near the viewport or a field gets focus.
  const activate = () => {
    if (c.active) return;
    c.active = true;
    update(c);
  };
  root.addEventListener('focusin', activate);
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) { io.disconnect(); activate(); }
    }, { rootMargin: '400px' });
    io.observe(root);
  } else {
    activate();
  }
}

// Changing a destination's state clears only that destination's location.
function wireDest(c, x) {
  const onChange = () => update(c);
  x.state.addEventListener('change', () => {
    x.selected = '';
    x.menuKey = x.wantMenu = null;
    clearResults(c);
    update(c);
  });
  x.location.addEventListener('change', () => { x.selected = x.location.value; update(c); });
  if (!x.arrive) return;
  x.arrive.addEventListener('input', onChange);
  x.arrive.addEventListener('change', onChange);
  openPickerOnClick(x.arrive);
  x.remove.addEventListener('click', () => removeDest(c, x));
}

// Add another destination (spec §6): a template row whose State menu copies destination 1's options,
// prefilled with the previous destination's state. Focus goes to its first visible field.
function addDest(c) {
  const e = c.e;
  if (c.dests.length >= MAX_DESTINATIONS) return;
  const x = newDest(rowHooks(document.importNode(e.tpl.content.firstElementChild, true)));
  Array.prototype.forEach.call(e.state.options, (o) => { if (o.value) x.state.add(new Option(o.text, o.value)); });
  x.state.value = c.dests[c.dests.length - 1].state.value;
  wireDest(c, x);
  e.list.appendChild(x.row);
  c.dests.push(x);
  layout(c);
  sync(c);
  (x.arriveField.hidden ? x.state : x.arrive).focus();
  update(c);
}

// Remove a destination; a menu still loading for it is dropped. Focus goes to the Add button.
function removeDest(c, x) {
  const i = c.dests.indexOf(x);
  if (i < 1) return;
  c.dests.splice(i, 1);
  x.wantMenu = null;
  x.row.parentNode.removeChild(x.row);
  layout(c);
  c.e.add.focus();
  update(c);
}

// Numbering after add or remove: legend, Remove label, ids and label for; the "Destination 1" title
// from 2 destinations; the Add button and its note at the limit.
function layout(c) {
  const e = c.e;
  const n = c.dests.length;
  c.dests.forEach((x, i) => {
    if (!i) return;
    const k = i + 1;
    setText(x.title, 'Destination ' + k);
    x.remove.setAttribute('aria-label', 'Remove destination ' + k);
    ['arrive', 'state', 'location'].forEach((name) => {
      const el = x[name];
      const label = (el.closest('.perdiem-calc_field') || el.parentNode).querySelector('label');
      el.id = 'pd-dest-' + k + '-' + name;
      if (label) label.htmlFor = el.id;
    });
    // Screen readers hear the row's dates (or its error) with its Arrive on field.
    if (x.status) {
      x.status.id = 'pd-dest-' + k + '-status';
      x.arrive.setAttribute('aria-describedby', x.status.id);
    }
  });
  if (e.title1) e.title1.hidden = n < 2;
  e.add.disabled = n >= MAX_DESTINATIONS;
  if (e.addNote) e.addNote.hidden = n < MAX_DESTINATIONS;
}

// A mouse or pen click anywhere in a date field opens the calendar, not only its icon. The pointer
// type comes from the pointerdown before the click: keyboard use (Tab, typing) has none, so it is
// untouched, and touch is skipped because phones open their own picker.
function openPickerOnClick(input) {
  let pointer = '';
  input.addEventListener('pointerdown', (ev) => { pointer = ev.pointerType; });
  input.addEventListener('click', () => {
    const type = pointer;
    pointer = '';
    if ((type !== 'mouse' && type !== 'pen') || input.disabled || typeof input.showPicker !== 'function') return;
    try {
      input.showPicker();
    } catch (err) { /* some browsers refuse; the field and its icon still work */ }
  });
}

function stateName(x) {
  const o = x.state.options[x.state.selectedIndex];
  return o ? o.text.trim() : '';
}

function setOptions(x, options, value, disabled) {
  const sel = x.location;
  while (sel.options.length) sel.remove(0);
  options.forEach((o) => sel.add(new Option(o.label, o.value)));
  sel.value = value;
  sel.disabled = disabled;
}

function sameDay(c) {
  const d = parseISODate(c.e.depart.value);
  return d !== null && d === parseISODate(c.e.return.value);
}

// Field state that follows the dates, re-applied on every update: the return date's min, the same-day
// switch (Arrive on hides, keeping its value), and each Arrive on's min (the previous destination's
// date + 1) and max (return − 1). Typed dates bypass min/max; validateTrip still checks them.
function sync(c) {
  const e = c.e;
  const d = parseISODate(e.depart.value);
  const r = parseISODate(e.return.value);
  const same = sameDay(c);
  const bound = (day, edge) => (day !== null ? toISODate(day) : c.range ? toISODate(c.range[edge]) : '');
  if (c.range) e.return.min = d !== null && (r === null || r < d) ? e.depart.value : toISODate(c.range.min);
  if (e.over12Wrap) e.over12Wrap.hidden = !same;
  let prev = d;
  c.dests.forEach((x, i) => {
    if (!i) return;
    x.arriveField.hidden = same;
    x.arrive.min = bound(prev !== null ? prev + 1 : null, 'min');
    x.arrive.max = bound(r !== null ? r - 1 : null, 'max');
    const a = parseISODate(x.arrive.value);
    if (a !== null) prev = a;
  });
  renderStatus(c);
}

// The line under each destination title (2+ destinations): the error about that destination, else
// the dates and nights it covers on an overnight trip, else nothing. The field an error is about
// (any destination or the trip dates) gets aria-invalid, which the CSS shows in red.
function renderStatus(c) {
  const e = c.e;
  const err = c.err;
  const several = c.dests.length > 1;
  const spans = several && !sameDay(c)
    ? destinationSpans(e.depart.value, e.return.value, c.dests.map((x) => (x.arrive ? x.arrive.value : '')))
    : [];
  c.dests.forEach((x, i) => {
    const el = i ? x.status : e.status1;
    if (!el) return;
    const own = several && err && err.dest === i;
    const text = own ? err.error : spans[i] ? spanText(spans[i]) : '';
    setText(el, text);
    el.hidden = !text;
    el.classList.toggle('is-error', !!own);
  });
  let target = null;
  if (err && err.field) target = err.dest === null || err.dest === undefined ? e[err.field] : c.dests[err.dest][err.field];
  const fields = [e.depart, e.return];
  c.dests.forEach((x) => fields.push(x.arrive, x.state, x.location));
  fields.forEach((f) => {
    if (!f) return;
    if (f === target) f.setAttribute('aria-invalid', 'true');
    else f.removeAttribute('aria-invalid');
  });
}

// Errors (not "Choose …" prompts) are marked on their destination and field.
function setError(c, res) {
  c.err = res && !res.ok && !res.incomplete ? res : null;
  renderStatus(c);
}

// Location menu of destination x for state st, built from fiscal year fy (phase-4 rule 6). Rebuilding
// for another fiscal year keeps the selection when the same did exists.
function ensureMenu(c, x, st, fy) {
  const key = st + '/' + fy;
  if (x.menuKey === key) return null;
  x.wantMenu = key;
  const url = stateUrl(fy, st);
  if (!loaded(url)) {
    setOptions(x, [{ value: '', label: 'Loading…' }], '', true);
    showMessage(c, c.initial, false);
  }
  return load(url).then((data) => {
    if (x.wantMenu !== key) return;
    const menu = buildLocationOptions(data, stateName(x));
    const options = menu.preselect ? menu.options
      : [{ value: '', label: 'Choose a city or county' }].concat(menu.options);
    const keep = x.menuState === st && x.selected &&
      options.some((o) => o.value === x.selected) ? x.selected : '';
    x.selected = keep || menu.preselect;
    setOptions(x, options, x.selected, false);
    x.menuKey = key;
    x.menuState = st;
  }, (err) => {
    if (x.wantMenu === key) {
      setOptions(x, [{ value: '', label: 'Rates couldn’t load' }], '', true);
      x.wantMenu = null;
    }
    throw err;
  });
}

// No state chosen: menuKey '' marks the menu as already showing "Choose a state first".
function clearMenu(x) {
  if (x.menuKey === '') return;
  x.menuKey = '';
  x.wantMenu = null;
  x.menuState = x.selected = '';
  setOptions(x, [{ value: '', label: 'Choose a state first' }], '', true);
}

// Recalculation trigger: every field change (and first activation) calls this. A newer call
// supersedes an older one still waiting on a fetch.
function update(c) {
  const seq = ++c.seq;
  const current = () => seq === c.seq;
  // Errors are re-checked on every change (compute marks them again if they remain).
  c.err = null;
  sync(c);
  // A state is chosen (preselected on state pages, prefilled on new rows) but its menu isn't built yet.
  const pending = (x) => x.state.value && (!x.menuKey || x.menuKey.indexOf(x.state.value + '/') !== 0);
  if (!loaded(META_URL)) {
    c.dests.forEach((x) => { if (pending(x)) setOptions(x, [{ value: '', label: 'Loading…' }], '', true); });
  }
  load(META_URL)
    .then((meta) => {
      if (!current()) return;
      if (!c.range) {
        c.range = availableRange(meta);
        [c.e.depart, c.e.return].forEach((el) => {
          el.min = toISODate(c.range.min);
          el.max = toISODate(c.range.max);
        });
        sync(c);
      }
      // Each menu uses the fiscal year of its destination's start: the departure date for
      // destination 1 and on same-day trips, else its Arrive on date, else the departure date.
      const same = sameDay(c);
      return Promise.all(c.dests.map((x, i) => {
        const st = x.state.value;
        if (!st) return clearMenu(x);
        const start = i && !same && parseISODate(x.arrive.value) !== null ? x.arrive.value : c.e.depart.value;
        return ensureMenu(c, x, st, menuFiscalYear(meta, start, todayIso()));
      })).then(() => { if (current()) return compute(c, meta, current); });
    })
    .catch((err) => {
      if (!current()) return;
      console.warn('[perdiem]', err);
      // Menus that failed say so themselves; this covers the ones meta.json never let start.
      c.dests.forEach((x) => {
        if (pending(x) && !x.wantMenu) setOptions(x, [{ value: '', label: 'Rates couldn’t load' }], '', true);
      });
      const tableBelow = c.pre && c.pre === c.e.state.value;
      showMessage(c, LOAD_ERROR + (tableBelow ? ' The full rate table is below.' : ''), true);
    });
}

function compute(c, meta, current) {
  const e = c.e;
  const d = e.depart.value;
  const r = e.return.value;
  if (!d && !r) return showMessage(c, c.initial, false);
  if (!d) return showMessage(c, 'Choose your departure date', false);
  if (!r) return showMessage(c, 'Choose your return date', false);
  const trip = {
    departIso: d, returnIso: r, over12: e.over12 ? e.over12.checked : undefined, meta: meta,
    destinations: c.dests.map((x) => ({ state: x.state.value, location: x.location.value,
      arrive: x.arrive ? x.arrive.value : null, stateName: stateName(x) }))
  };
  const v = validateTrip(trip, meta);
  if (!v.ok) {
    setError(c, v);
    return showMessage(c, v.error, !v.incomplete);
  }

  // Exactly the state files the trip reads. Don't leave the previous result on screen while one loads.
  const urls = v.needed.map((p) => stateUrl(p[0], p[1]));
  if (!urls.every(loaded)) showMessage(c, c.initial, false);
  return Promise.all(urls.map(load)).then((list) => {
    if (!current()) return;
    trip.files = {};
    v.needed.forEach((p, i) => { (trip.files[p[0]] = trip.files[p[0]] || {})[p[1]] = list[i]; });
    const res = calculateTrip(trip);
    if (!res.ok) {
      setError(c, res);
      // One destination keeps the v1.0.1 wording.
      return showMessage(c, res.rateGap && c.dests.length === 1 ? MESSAGES.locationGap : res.error, true);
    }

    setText(e.days, String(res.days));
    setText(e.total, formatMoney(res.total));
    setText(e.lodging, formatMoney(res.lodging));
    setText(e.meals, formatMoney(res.meals));
    setText(e.incidentals, formatMoney(res.incidentals));
    setText(e.message, tripSummaryText(res, d, r));
    e.message.classList.remove('is-error');
    // A day trip of 12 hours or less is a valid $0 result, with nothing to export.
    e.export.disabled = res.tripType === 'day_short';
    renderBreakdown(c, res);
    c.result = {
      key: [d, r, trip.over12].concat(trip.destinations.map((x) => [x.state, x.location, x.arrive].join('/')))
        .join('|'),
      res: res, d: d, r: r, params: analyticsParams(res)
    };
    scheduleCalculateEvent(c);
  });
}

function clearResults(c) {
  const e = c.e;
  setText(e.days, '0');
  ['total', 'lodging', 'meals', 'incidentals'].forEach((k) => setText(e[k], '$0'));
  e.export.disabled = true;
  renderBreakdown(c, null);
  c.result = null;
  clearTimeout(c.timer);
}

// Result panel, overnight trips with 2+ destinations: one line per destination in travel order, with
// its dates, nights and total, cloned from the breakdown template.
function renderBreakdown(c, res) {
  if (!c.line) return;
  const list = c.e.breakdownList;
  const show = !!res && res.tripType === 'overnight' && res.destinations.length > 1;
  while (list.firstChild) list.removeChild(list.firstChild);
  if (show) {
    res.destinations.forEach((d) => {
      const li = document.importNode(c.line, true);
      const item = (n) => li.querySelector('[data-pd-item="' + n + '"]');
      item('place').textContent = d.place;
      item('dates').textContent = spanText(d);
      item('amount').textContent = formatMoney(d.total);
      list.appendChild(li);
    });
  }
  c.e.breakdown.hidden = !show;
}

function showMessage(c, text, isError) {
  clearResults(c);
  setText(c.e.message, text);
  c.e.message.classList.toggle('is-error', isError);
}

// perdiem_calculate: once per distinct valid result, after the inputs settle for 1.5 s.
function scheduleCalculateEvent(c) {
  clearTimeout(c.timer);
  const key = c.result.key;
  if (c.fired[key]) return;
  c.timer = setTimeout(() => {
    if (!c.result || c.result.key !== key) return;
    c.fired[key] = true;
    track('perdiem_calculate', c.result.params);
  }, 1500);
}

function exportCsv(c) {
  const x = c.result;
  if (!x || x.res.tripType === 'day_short') return;
  const csv = buildCsv(x.res, x.d, x.r, todayIso());
  const url = URL.createObjectURL(new Blob([csv.text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = csv.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  track('perdiem_export', x.params);
}

function start() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-perdiem-calc]'), init);
}

window.ItilitePerDiem = { base: BASE, cache: cache, calculate: calculate, calculateTrip: calculateTrip,
  validateDates: validateDates };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
})();

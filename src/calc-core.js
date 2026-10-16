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

export const MAX_DESTINATIONS = 5;

// k is the 1-based destination number; place is a placeName().
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
  rateGap: function (place) { return 'Rates for ' + place + ' aren’t available for all of your dates.'; }
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
// { ok: false, error }.
export function validateDates(departIso, returnIso, meta) {
  const depart = parseISODate(departIso);
  const ret = parseISODate(returnIso);
  if (depart === null || ret === null) return { ok: false, error: 'Enter dates as YYYY-MM-DD.' };
  if (ret < depart) return { ok: false, error: MESSAGES.returnBeforeDepart };
  const days = ret - depart + 1;
  if (days > MAX_DAYS) return { ok: false, error: MESSAGES.tooLong };

  const range = availableRange(meta);
  if (depart < range.min) {
    return { ok: false, error: 'Rates for ' + monthYear(depart) + ' are no longer available.' };
  }
  const fiscalYears = [];
  for (let day = depart; day <= ret; day++) {
    const fy = fiscalYearOf(day);
    if (range.years.indexOf(fy) === -1) {
      return { ok: false, error: 'Rates for ' + monthYear(day) + ' aren’t published yet.' };
    }
    if (fiscalYears.indexOf(fy) === -1) fiscalYears.push(fy);
  }
  return { ok: true, depart: depart, ret: ret, days: days, fiscalYears: fiscalYears };
}

// "Choose …" prompts are incomplete input, shown without the error style; the rest are errors.
function prompt(text) {
  return { ok: false, error: text, incomplete: true };
}

function fail(text) {
  return { ok: false, error: text, incomplete: false };
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
  if (!v.ok) return fail(v.error);
  const sameDay = v.days === 1;

  // Same-day trips ignore Arrive on: every destination starts on the departure date.
  const starts = [];
  for (let i = 0; i < dests.length; i++) {
    const k = i + 1;
    let start = v.depart;
    if (i > 0 && !sameDay) {
      start = parseISODate(dests[i].arrive);
      if (start === null) return prompt(MESSAGES.destArrive(k));
      if (start < v.depart || start > v.ret) return fail(MESSAGES.destOutside(k));
      if (start < starts[i - 1]) return fail(MESSAGES.destOrder(k));
    }
    starts.push(start);
    if (!dests[i].state) return prompt(i === 0 ? MESSAGES.chooseState : MESSAGES.destState(k));
    if (!dests[i].location) return prompt(i === 0 ? MESSAGES.chooseLocation : MESSAGES.destLocation(k));
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
  if (!v.sameDay) {
    for (let i = 0; i < dests.length; i++) {
      if (v.nights[i] === 0) return fail(MESSAGES.noNight(places[i]));
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
    return { ok: false, error: MESSAGES.rateGap(places[k]), incomplete: false, rateGap: true };
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
  if (!r.ok) return r.rateGap ? fail(MESSAGES.locationGap) : r;
  const named = r.rows.some(function (row) { return !row.standard; });
  r.city = input.location !== 'std' && named ? r.destinations[0].place : null;
  return r;
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

// Summary for a calculateTrip result: places in travel order ("A", "A and B", "A, B and C"). A
// same-day trip to several places names the one whose rate applies. day_short gives its notice.
export function tripSummaryText(result, departIso, returnIso) {
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

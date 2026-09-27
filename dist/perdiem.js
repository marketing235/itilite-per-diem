/*! ITILITE per diem calculator | built from src/ by scripts/build-js.js, do not edit */
(function () {
'use strict';

// ---- src/calc-core.js ----
// Pure per diem calculation functions: no DOM, no fetch. Spec: docs/phase-4-calculator.md.
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

const MESSAGES = {
  returnBeforeDepart: 'Your return date is before your departure date.',
  tooLong: 'Trips can be up to ' + MAX_DAYS + ' days.',
  locationGap: 'Rates for this location aren’t available for all of your dates.'
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
// { ok: false, error }.
function validateDates(departIso, returnIso, meta) {
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

// input: { departIso, returnIso, meta, files: { [fy]: stateData }, location: did | 'std' }
// files must hold every fiscal year the trip touches (validateDates(...).fiscalYears).
// Returns { ok: true, days, nights, lodging, mie, meals, incidentals, total, city, rows[] }
// or { ok: false, error }. All money in dollars, exact (quarters are exact in binary).
function calculate(input) {
  const v = validateDates(input.departIso, input.returnIso, input.meta);
  if (!v.ok) return v;
  const fullIncidentals = input.meta.incidentals;
  const rows = [];
  const sum = { lodging: 0, mie: 0, meals: 0, incidentals: 0 };
  let city = null;

  for (let i = 0; i < v.days; i++) {
    const day = v.depart + i;
    const fy = fiscalYearOf(day);
    const file = input.files[fy];
    if (!file) throw new Error('calculate: no data file for FY' + fy);
    const rate = resolveRate(file, input.location);
    if (!rate) return { ok: false, error: MESSAGES.locationGap };
    if (city === null && rate.city !== null) city = rate.city;

    const edge = i === 0 || i === v.days - 1;
    const lodging = i < v.days - 1 ? rate.lodging[dayParts(day).month] : 0;
    const mie = edge ? rate.mie * 0.75 : rate.mie;
    const incidentals = edge ? fullIncidentals * 0.75 : fullIncidentals;
    const meals = mie - incidentals;
    rows.push({ date: toISODate(day), fiscalYear: fy, lodging: lodging, meals: meals,
      incidentals: incidentals, mie: mie, total: lodging + mie, standard: rate.standard });
    sum.lodging += lodging;
    sum.mie += mie;
    sum.meals += meals;
    sum.incidentals += incidentals;
  }

  return { ok: true, days: v.days, nights: v.days - 1, lodging: sum.lodging, mie: sum.mie,
    meals: sum.meals, incidentals: sum.incidentals, total: sum.lodging + sum.mie, city: city,
    rows: rows };
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
function summaryText(result, place, departIso, returnIso) {
  return result.days + (result.days === 1 ? ' day' : ' days') + ' in ' + place + ', ' +
    formatDateRange(parseISODate(departIso), parseISODate(returnIso)) +
    '. Total allowance ' + formatMoney(result.total) + '.';
}

// ---- src/perdiem.js ----
// DOM wiring for the per diem calculator. Spec: docs/phase-4-calculator.md.
// Adds behaviour to the existing Webflow markup (data-pd hooks) — never adds layout or styles.
// Only runs as part of dist/perdiem.js: scripts/build-js.js drops the import below and inlines
// calc-core.js into the same IIFE. Keep syntax at ES2019 or older.


// Must be read while the script first executes; it is null inside later callbacks.
const SCRIPT = document.currentScript;
const FALLBACK_BASE = 'https://cdn.jsdelivr.net/gh/marketing235/itilite-per-diem@v1.0.0/';
const HOOKS = ['depart', 'return', 'state', 'location', 'message', 'export', 'days', 'total',
  'lodging', 'meals', 'incidentals'];
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

function init(root) {
  const e = {};
  for (let i = 0; i < HOOKS.length; i++) {
    e[HOOKS[i]] = root.querySelector('[data-pd="' + HOOKS[i] + '"]');
    if (!e[HOOKS[i]]) {
      console.warn('[perdiem] missing hook data-pd="' + HOOKS[i] + '"; calculator not started');
      return;
    }
  }
  const pre = (root.getAttribute('data-state') || '').trim().toUpperCase();
  const c = {
    e: e, pre: pre, initial: e.message.textContent, seq: 0, active: false, range: null,
    menuKey: null, wantMenu: null, menuState: '', selected: '', result: null, timer: 0, fired: {}
  };
  if (pre && Array.prototype.some.call(e.state.options, (o) => o.value === pre)) e.state.value = pre;

  const onDates = () => { syncReturnMin(c); update(c); };
  ['input', 'change'].forEach((type) => {
    e.depart.addEventListener(type, onDates);
    e.return.addEventListener(type, onDates);
  });
  e.state.addEventListener('change', () => {
    c.selected = '';
    c.menuKey = c.wantMenu = null;
    clearResults(c);
    update(c);
  });
  e.location.addEventListener('change', () => { c.selected = e.location.value; update(c); });
  e.export.addEventListener('click', () => exportCsv(c));

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

function stateName(c) {
  const o = c.e.state.options[c.e.state.selectedIndex];
  return o ? o.text.trim() : '';
}

function setOptions(c, options, value, disabled) {
  const sel = c.e.location;
  while (sel.options.length) sel.remove(0);
  options.forEach((o) => sel.add(new Option(o.label, o.value)));
  sel.value = value;
  sel.disabled = disabled;
}

function syncReturnMin(c) {
  if (!c.range) return;
  const d = parseISODate(c.e.depart.value);
  const r = parseISODate(c.e.return.value);
  c.e.return.min = d !== null && (r === null || r < d) ? c.e.depart.value : toISODate(c.range.min);
}

// Location menu for state st, built from fiscal year fy (rule 6). Rebuilding for another fiscal
// year keeps the selection when the same did exists.
function ensureMenu(c, st, fy) {
  const key = st + '/' + fy;
  if (c.menuKey === key) return Promise.resolve();
  c.wantMenu = key;
  const url = stateUrl(fy, st);
  if (!loaded(url)) {
    setOptions(c, [{ value: '', label: 'Loading…' }], '', true);
    showMessage(c, c.initial, false);
  }
  return load(url).then((data) => {
    if (c.wantMenu !== key) return;
    const menu = buildLocationOptions(data, stateName(c));
    const options = menu.preselect ? menu.options
      : [{ value: '', label: 'Choose a city or county' }].concat(menu.options);
    const keep = c.menuState === st && c.selected &&
      options.some((o) => o.value === c.selected) ? c.selected : '';
    c.selected = keep || menu.preselect;
    setOptions(c, options, c.selected, false);
    c.menuKey = key;
    c.menuState = st;
  }, (err) => {
    if (c.wantMenu === key) {
      setOptions(c, [{ value: '', label: 'Rates couldn’t load' }], '', true);
      c.wantMenu = null;
    }
    throw err;
  });
}

// No state chosen: menuKey '' marks the menu as already showing "Choose a state first".
function clearMenu(c) {
  if (c.menuKey === '') return;
  c.menuKey = '';
  c.wantMenu = null;
  c.menuState = c.selected = '';
  setOptions(c, [{ value: '', label: 'Choose a state first' }], '', true);
}

// Recalculation trigger: every field change (and first activation) calls this. A newer call
// supersedes an older one still waiting on a fetch.
function update(c) {
  const seq = ++c.seq;
  const current = () => seq === c.seq;
  // A state is chosen (preselected on state pages) but its menu isn't built yet.
  const menuPending = () => c.e.state.value && (!c.menuKey || c.menuKey.indexOf(c.e.state.value + '/') !== 0);
  if (menuPending() && !loaded(META_URL)) setOptions(c, [{ value: '', label: 'Loading…' }], '', true);
  load(META_URL)
    .then((meta) => {
      if (!current()) return;
      if (!c.range) {
        c.range = availableRange(meta);
        [c.e.depart, c.e.return].forEach((el) => {
          el.min = toISODate(c.range.min);
          el.max = toISODate(c.range.max);
        });
        syncReturnMin(c);
      }
      const st = c.e.state.value;
      if (!st) {
        clearMenu(c);
        return compute(c, meta, current);
      }
      return ensureMenu(c, st, menuFiscalYear(meta, c.e.depart.value, todayIso()))
        .then(() => { if (current()) return compute(c, meta, current); });
    })
    .catch((err) => {
      if (!current()) return;
      console.warn('[perdiem]', err);
      if (menuPending()) setOptions(c, [{ value: '', label: 'Rates couldn’t load' }], '', true);
      const tableBelow = c.pre && c.pre === c.e.state.value;
      showMessage(c, LOAD_ERROR + (tableBelow ? ' The full rate table is below.' : ''), true);
    });
}

function compute(c, meta, current) {
  const e = c.e;
  const d = e.depart.value;
  const r = e.return.value;
  const st = e.state.value;
  const loc = e.location.value;
  if (!d && !r) return showMessage(c, c.initial, false);
  if (!d) return showMessage(c, 'Choose your departure date', false);
  if (!r) return showMessage(c, 'Choose your return date', false);
  const v = validateDates(d, r, meta);
  if (!v.ok) return showMessage(c, v.error, true);
  if (!st) return showMessage(c, 'Choose a state', false);
  if (!loc) return showMessage(c, 'Choose a city or county', false);

  // Don't leave the previous trip's result on screen while another fiscal year's file loads.
  if (!v.fiscalYears.every((fy) => loaded(stateUrl(fy, st)))) showMessage(c, c.initial, false);
  return Promise.all(v.fiscalYears.map((fy) => load(stateUrl(fy, st)))).then((list) => {
    if (!current()) return;
    const files = {};
    v.fiscalYears.forEach((fy, i) => { files[fy] = list[i]; });
    const res = calculate({ departIso: d, returnIso: r, meta: meta, files: files, location: loc });
    if (!res.ok) return showMessage(c, res.error, true);

    const name = stateName(c);
    const place = loc === 'std' ? name + ' (standard rate)' : e.location.options[e.location.selectedIndex].text;
    setText(e.days, String(res.days));
    setText(e.total, formatMoney(res.total));
    setText(e.lodging, formatMoney(res.lodging));
    setText(e.meals, formatMoney(res.meals));
    setText(e.incidentals, formatMoney(res.incidentals));
    setText(e.message, summaryText(res, place, d, r));
    e.message.classList.remove('is-error');
    e.export.disabled = false;
    c.result = {
      key: [st, loc, d, r].join('|'), res: res, st: st, name: name, loc: loc, place: place, d: d, r: r,
      params: { state: st, location_type: loc === 'std' ? 'standard' : 'nsa', days: res.days }
    };
    scheduleCalculateEvent(c);
  });
}

function clearResults(c) {
  const e = c.e;
  setText(e.days, '0');
  ['total', 'lodging', 'meals', 'incidentals'].forEach((k) => setText(e[k], '$0'));
  e.export.disabled = true;
  c.result = null;
  clearTimeout(c.timer);
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

// Quoted, quotes doubled; a leading = + - @ (or tab/CR) gets a ' so Excel treats it as text.
function csvCell(value) {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// Plain numbers for Excel in any locale: 279, 65.25 (never $ or thousands separators).
const csvNumber = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

function buildCsv(x) {
  const res = x.res;
  const n = csvNumber;
  const range = formatDateRange(parseISODate(x.d), parseISODate(x.r));
  const today = parseISODate(todayIso());
  const lines = [
    ['ITILITE per diem estimate'],
    [x.loc === 'std' ? 'Standard rate, ' + x.name : x.place + ', ' + x.name],
    ['Travel dates: ' + range + ' (' + res.days + (res.days === 1 ? ' day)' : ' days)')],
    ['Source: U.S. General Services Administration per diem rates'],
    ['Generated ' + formatDateRange(today, today)],
    [],
    ['Date', 'Fiscal year', 'Lodging (USD)', 'Meals (USD)', 'Incidentals (USD)', 'Day total (USD)']
  ];
  res.rows.forEach((row, i) => {
    lines.push([row.date, 'FY' + row.fiscalYear, i < res.nights ? n(row.lodging) : '',
      n(row.meals), n(row.incidentals), n(row.total)]);
  });
  lines.push(['Total', '', n(res.lodging), n(res.meals), n(res.incidentals), n(res.total)]);
  return lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function exportCsv(c) {
  const x = c.result;
  if (!x) return;
  const blob = new Blob(['﻿' + buildCsv(x)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'per-diem-' + x.st.toLowerCase() + '-' + x.d + '-to-' + x.r + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  track('perdiem_export', x.params);
}

function start() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-perdiem-calc]'), init);
}

window.ItilitePerDiem = { base: BASE, cache: cache, calculate: calculate, validateDates: validateDates };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
})();

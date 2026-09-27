// DOM wiring for the per diem calculator. Spec: docs/phase-4-calculator.md.
// Adds behaviour to the existing Webflow markup (data-pd hooks) — never adds layout or styles.
// Only runs as part of dist/perdiem.js: scripts/build-js.js drops the import below and inlines
// calc-core.js into the same IIFE. Keep syntax at ES2019 or older.

import {
  parseISODate, toISODate, availableRange, menuFiscalYear, validateDates, buildLocationOptions,
  calculate, formatMoney, formatDateRange, summaryText
} from './calc-core.js';

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

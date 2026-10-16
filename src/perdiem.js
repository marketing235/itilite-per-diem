// DOM wiring for the per diem calculator. Spec: docs/phase-4-calculator.md, extended by
// docs/v1.1.0-multi-city.md (multi-city rows, same-day switch).
// Adds behaviour to the existing Webflow markup (data-pd hooks) — never adds layout or styles, apart
// from cloning the v1.1 templates: destination rows and result breakdown lines (spec §7, §17).
// Only runs as part of dist/perdiem.js: scripts/build-js.js drops the import below and inlines
// calc-core.js into the same IIFE. Keep syntax at ES2019 or older.

import {
  parseISODate, toISODate, availableRange, menuFiscalYear, validateDates, validateTrip, buildLocationOptions,
  calculate, calculateTrip, formatMoney, tripSummaryText, buildCsv, analyticsParams, destinationSpans, spanText,
  MESSAGES, MAX_DESTINATIONS
} from './calc-core.js';

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

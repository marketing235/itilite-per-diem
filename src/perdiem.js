// DOM wiring for the per diem calculator. Spec: docs/phase-4-calculator.md, extended by
// docs/v1.1.0-multi-city.md (multi-city rows, same-day switch), docs/v1.2.0-separate-trips.md
// (separate trips) and docs/v1.3.0-compare-cities.md (Compare cities mode).
// Adds behaviour to the existing Webflow markup (data-pd hooks) — never adds layout or styles, apart
// from cloning the templates: trip blocks, destination rows, city rows and result lines (v1.1 §7, §17,
// v1.2 §5, v1.3 §6).
// Only runs as part of dist/perdiem.js: scripts/build-js.js drops the import below and inlines
// calc-core.js into the same IIFE. Keep syntax at ES2019 or older.

import {
  parseISODate, toISODate, availableRange, menuFiscalYear, validateDates, buildLocationOptions,
  calculate, calculateTrip, calculatePlan, planNeeded, formatMoney, tripSummaryText, planSummaryText, buildCsv,
  buildPlanCsv, planAnalyticsParams, breakdownLines, allShort, destinationSpans, spanText, tripDatesText,
  calculateCompare, compareNeeded, compareSummaryText, compareLines, compareAnalyticsParams, buildCompareCsv,
  MESSAGES, MAX_DESTINATIONS, MAX_TRIPS, MAX_CITIES
} from './calc-core.js';

// Must be read while the script first executes; it is null inside later callbacks.
const SCRIPT = document.currentScript;
const FALLBACK_BASE = 'https://cdn.jsdelivr.net/gh/marketing235/itilite-per-diem@v1.3.0/';
const HOOKS = ['depart', 'return', 'state', 'location', 'message', 'export', 'days', 'total',
  'lodging', 'meals', 'incidentals'];
// v1.1 hooks, all optional (spec §7). Without dest-list, dest-template and add the calculator keeps one
// destination, as v1.0.1; without over12 a same-day trip pays the 75% day.
const V11_HOOKS = { over12: 'over12', over12Wrap: 'over12-wrap', title1: 'dest1-title', list: 'dest-list',
  tpl: 'dest-template', addWrap: 'add-wrap', add: 'add', addNote: 'add-note', status1: 'dest1-status',
  breakdown: 'breakdown', breakdownList: 'breakdown-list', breakdownTpl: 'breakdown-template' };
// v1.2 hooks (spec §5). Without trip-list, trip-template and add-trip, or without the v1.1 destination
// rows, the calculator keeps one trip, as v1.1.0. title and status are trip 1's "Trip 1" title and dates
// line, under the keys a trip block uses for its own. total-label, breakdown-title and the By trip line
// template are optional.
const V12_HOOKS = { title: 'trip1-title', status: 'trip1-status', tripList: 'trip-list', tripTpl: 'trip-template',
  addTripWrap: 'add-trip-wrap', addTrip: 'add-trip', addTripNote: 'add-trip-note', totalLabel: 'total-label',
  breakdownTitle: 'breakdown-title', tripLineTpl: 'trip-breakdown-template' };
// data-pd-trip hooks inside one trip block, under the keys trip 1 uses for the same parts.
const TRIP_HOOKS = { title: 'title', remove: 'remove', status: 'status', depart: 'depart', return: 'return',
  over12Wrap: 'over12-wrap', over12: 'over12', title1: 'dest1-title', status1: 'dest1-status', state: 'state',
  location: 'location', list: 'dest-list', addWrap: 'add-wrap', add: 'add', addNote: 'add-note' };
// data-pd-dest hooks inside one template row ("status" is optional: the row's dates or its error).
const ROW_HOOKS = { title: 'title', remove: 'remove', arriveField: 'arrive-field', arrive: 'arrive',
  state: 'state', location: 'location' };
// data-pd-item hooks inside one result breakdown line.
const ITEM_HOOKS = ['place', 'dates', 'amount'];
// v1.3 hooks (spec §6). Compare cities runs only with all of these (and the two mode buttons, a complete
// city row and a complete result line); without mode, compare-panel or result-compare the calculator runs
// exactly as v1.2.0. The same-day switch and the "Up to 5 cities." note are optional, as in Calculate.
const CMP_HOOKS = { mode: 'mode', calcPanel: 'calc-panel', panel: 'compare-panel', resultCalc: 'result-calc',
  resultCmp: 'result-compare', depart: 'cmp-depart', return: 'cmp-return', list: 'cmp-list', tpl: 'cmp-template',
  add: 'cmp-add', results: 'cmp-results', lineTpl: 'cmp-result-template' };
const CMP_OPTIONAL = { over12Wrap: 'cmp-over12-wrap', over12: 'cmp-over12', addNote: 'cmp-add-note' };
// data-pd-city hooks inside one city row, and data-pd-item hooks inside one compare result line.
const CITY_HOOKS = { title: 'title', remove: 'remove', status: 'status', state: 'state', location: 'location' };
const CMP_ITEMS = ITEM_HOOKS.concat('badge');
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

const on = (el, type, fn) => el.addEventListener(type, fn);
const clone = (tpl) => document.importNode(tpl.content.firstElementChild, true);

// x plus the hooks (attr="…", hooks: { key: value }) found inside el, or null if any is missing. Every
// lookup is scoped to el.
function hooksIn(el, attr, hooks, x) {
  const names = Object.keys(hooks);
  for (let i = 0; i < names.length; i++) {
    x[names[i]] = el.querySelector('[' + attr + '="' + hooks[names[i]] + '"]');
    if (!x[names[i]]) return null;
  }
  return x;
}

// The hooks of one template row, or null if any is missing.
function rowHooks(row) {
  const x = hooksIn(row, 'data-pd-dest', ROW_HOOKS, { row: row });
  if (x) x.status = row.querySelector('[data-pd-dest="status"]');
  return x;
}

// The hooks of one trip block, or null if any is missing. Its destination rows use data-pd-dest, so a
// block only ever finds its own parts.
function tripHooks(block) {
  return hooksIn(block, 'data-pd-trip', TRIP_HOOKS, { block: block });
}

// A result line template's element if it has every item hook in items, else null.
function lineOf(tpl, items) {
  const el = tpl && tpl.content && tpl.content.firstElementChild;
  return el && items.every((n) => el.querySelector('[data-pd-item="' + n + '"]')) ? el : null;
}

// The Compare cities parts (v1.3 §6), or null if any required one is missing: K holds the CMP_HOOKS,
// the optional ones (or null), the two mode buttons, the result line, and later the city rows.
function compareHooks(root) {
  const K = hooksIn(root, 'data-pd', CMP_HOOKS, { cities: [], copied: false, err: null });
  if (!K) return null;
  Object.keys(CMP_OPTIONAL).forEach((k) => { K[k] = root.querySelector('[data-pd="' + CMP_OPTIONAL[k] + '"]'); });
  K.calcBtn = K.mode.querySelector('[data-pd-mode="calculate"]');
  K.cmpBtn = K.mode.querySelector('[data-pd-mode="compare"]');
  K.line = lineOf(K.lineTpl, CMP_ITEMS);
  const row = K.tpl.content && K.tpl.content.firstElementChild;
  return K.calcBtn && K.cmpBtn && K.line && row && hooksIn(row, 'data-pd-city', CITY_HOOKS, {}) ? K : null;
}

// A destination: its State and City or county selects (destination 1: the trip's own, arrive null;
// k >= 2: a template row) plus the state of its location menu.
function newDest(x) {
  x.menuKey = x.wantMenu = null;
  x.menuState = x.selected = '';
  return x;
}

// A trip: its dates, switch, titles, status lines, buttons (TRIP_HOOKS keys; trip 1: the page's data-pd
// hooks, trip k >= 2: a cloned block) and its destinations.
function newTrip(T) {
  T.dests = [newDest({ state: T.state, location: T.location, arrive: null })];
  return T;
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
  [V11_HOOKS, V12_HOOKS].forEach((hooks) => Object.keys(hooks).forEach((k) => { e[k] = q(hooks[k]); }));
  const incomplete = (what, hooks) => console.warn('[perdiem] incomplete ' + what + ' markup (' + hooks +
    '); running with one ' + what);
  const parts = [e.list, e.tpl, e.add].filter(Boolean).length;
  const row = parts === 3 && e.tpl.content && e.tpl.content.firstElementChild;
  const multi = !!(row && rowHooks(row));
  if (parts && !multi) incomplete('destination', 'dest-list, dest-template, add, data-pd-dest');
  // Separate trips need the destination rows too: every trip block has its own.
  const tparts = [e.tripList, e.tripTpl, e.addTrip].filter(Boolean).length;
  const block = tparts === 3 && e.tripTpl.content && e.tripTpl.content.firstElementChild;
  const trips = !!(multi && block && tripHooks(block));
  if (tparts && !trips) incomplete('trip', 'trip-list, trip-template, add-trip, data-pd-trip, destination rows');

  // Breakdown in the result: its list and line templates with every item hook (destination lines; for a
  // plan, also trip lines).
  const line = e.breakdown && e.breakdownList ? lineOf(e.breakdownTpl, ITEM_HOOKS) : null;
  const cparts = ['mode', 'compare-panel', 'result-compare'].filter(q).length;
  const cmp = cparts === 3 ? compareHooks(root) : null;
  if (cparts && !cmp) {
    console.warn('[perdiem] incomplete compare markup (mode, calc-panel, compare-panel, result-calc, ' +
      'result-compare, cmp-…, data-pd-mode, data-pd-city, data-pd-item); running without Compare cities');
  }

  const pre = (root.getAttribute('data-state') || '').trim().toUpperCase();
  const first = {};
  Object.keys(TRIP_HOOKS).forEach((k) => { first[k] = e[k] || null; });
  const c = {
    e: e, pre: pre, initial: e.message.textContent, seq: 0, active: false, range: null, err: null,
    multi: multi, line: line, tripLine: line && lineOf(e.tripLineTpl, ITEM_HOOKS), trips: [newTrip(first)],
    result: null, timer: 0, fired: {}, totalText: e.totalLabel ? e.totalLabel.textContent : '',
    byDest: e.breakdownTitle ? e.breakdownTitle.textContent : '', cmp: cmp, mode: 'calculate'
  };
  if (pre && Array.prototype.some.call(e.state.options, (o) => o.value === pre)) e.state.value = pre;

  wireTrip(c, c.trips[0]);
  on(e.export, 'click', () => exportCsv(c));
  if (trips) {
    on(e.addTrip, 'click', () => addTrip(c));
    if (e.addTripWrap) e.addTripWrap.hidden = false;
  }
  if (cmp) wireCompare(c);

  // Lazy start: nothing is fetched until the card is near the viewport or a field gets focus.
  const activate = () => {
    if (c.active) return;
    c.active = true;
    update(c);
  };
  on(root, 'focusin', activate);
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) { io.disconnect(); activate(); }
    }, { rootMargin: '400px' });
    io.observe(root);
  } else {
    activate();
  }
}

// A trip's dates, switch, destination 1, Add another destination and (trip k >= 2) Remove.
function wireTrip(c, T) {
  const onChange = () => update(c);
  ['input', 'change'].forEach((type) => {
    on(T.depart, type, onChange);
    on(T.return, type, onChange);
  });
  openPickerOnClick(T.depart);
  openPickerOnClick(T.return);
  wireDest(c, T, T.dests[0]);
  if (T.over12) on(T.over12, 'change', onChange);
  if (c.multi) {
    on(T.add, 'click', () => addDest(c, T));
    if (T.addWrap) T.addWrap.hidden = false;
  }
  if (T.remove) on(T.remove, 'click', () => removeTrip(c, T));
}

// Changing a destination's state clears only that destination's location.
function wireDest(c, T, x) {
  const onChange = () => update(c);
  on(x.state, 'change', () => {
    x.selected = '';
    x.menuKey = x.wantMenu = null;
    clearResults(c);
    update(c);
  });
  on(x.location, 'change', () => { x.selected = x.location.value; update(c); });
  if (!x.arrive) return;
  on(x.arrive, 'input', onChange);
  on(x.arrive, 'change', onChange);
  openPickerOnClick(x.arrive);
  on(x.remove, 'click', () => removeDest(c, T, x));
}

// A cloned State menu gets trip 1 destination 1's 49 options.
function copyStates(c, select) {
  Array.prototype.forEach.call(c.e.state.options, (o) => { if (o.value) select.add(new Option(o.text, o.value)); });
}

// Add another destination (v1.1 spec §6), in trip T: a template row prefilled with the previous
// destination's state. Focus goes to its first visible field.
function addDest(c, T) {
  if (T.dests.length >= MAX_DESTINATIONS) return;
  const x = newDest(rowHooks(clone(c.e.tpl)));
  copyStates(c, x.state);
  x.state.value = T.dests[T.dests.length - 1].state.value;
  wireDest(c, T, x);
  T.list.appendChild(x.row);
  T.dests.push(x);
  layout(c);
  sync(c);
  (x.arriveField.hidden ? x.state : x.arrive).focus();
  update(c);
}

// Remove a destination; a menu still loading for it is dropped. Focus goes to its trip's Add button.
function removeDest(c, T, x) {
  const i = T.dests.indexOf(x);
  if (i < 1) return;
  T.dests.splice(i, 1);
  x.wantMenu = null;
  x.row.parentNode.removeChild(x.row);
  layout(c);
  T.add.focus();
  update(c);
}

// Add another trip (v1.2 spec §4): a trip block with empty dates, its destination 1 State prefilled with
// the previous trip's last destination state. Focus goes to its Departure date.
function addTrip(c) {
  const e = c.e;
  if (c.trips.length >= MAX_TRIPS) return;
  const T = newTrip(tripHooks(clone(e.tripTpl)));
  const prev = c.trips[c.trips.length - 1];
  copyStates(c, T.state);
  T.state.value = prev.dests[prev.dests.length - 1].state.value;
  if (c.range) dateBounds(c, T);
  wireTrip(c, T);
  e.tripList.appendChild(T.block);
  c.trips.push(T);
  layout(c);
  sync(c);
  T.depart.focus();
  update(c);
}

// Remove a trip with its destinations; their menus still loading are dropped. Focus goes to Add another
// trip.
function removeTrip(c, T) {
  const t = c.trips.indexOf(T);
  if (t < 1) return;
  c.trips.splice(t, 1);
  T.dests.forEach((x) => { x.wantMenu = null; });
  T.block.parentNode.removeChild(T.block);
  layout(c);
  c.e.addTrip.focus();
  update(c);
}

// Compare cities (v1.3 §4): the mode buttons, the shared dates and switch, Add another city, and the two
// starting rows, city 1 with the state page's state as in Calculate. Then the switch shows.
function wireCompare(c) {
  const K = c.cmp;
  const onChange = () => update(c);
  [K.depart, K.return].forEach((el) => {
    on(el, 'input', onChange);
    on(el, 'change', onChange);
    openPickerOnClick(el);
  });
  if (K.over12) on(K.over12, 'change', onChange);
  on(K.add, 'click', () => addCity(c));
  on(K.calcBtn, 'click', () => setMode(c, 'calculate'));
  on(K.cmpBtn, 'click', () => setMode(c, 'compare'));
  newCity(c, c.pre && c.e.state.value === c.pre ? c.pre : '');
  newCity(c, '');
  layoutCompare(c);
  K.mode.hidden = false;
}

// The mode switch (v1.3 §4): one panel and its results show, each mode keeping its own inputs. The first
// switch to Compare copies trip 1's dates, switch and destination 1 into the compare dates and city 1,
// where they are filled; city 2 stays empty. Focus stays on the button.
function setMode(c, mode) {
  const K = c.cmp;
  const cmp = mode === 'compare';
  if (c.mode === mode) return;
  if (cmp && !K.copied) {
    const T = c.trips[0];
    const x = T.dests[0];
    const city = K.cities[0];
    K.copied = true;
    if (T.depart.value) K.depart.value = T.depart.value;
    if (T.return.value) K.return.value = T.return.value;
    if (T.over12 && K.over12) K.over12.checked = T.over12.checked;
    if (x.state.value) {
      city.state.value = x.state.value;
      newDest(city);
      // The menu, once built, keeps destination 1's city (same state, same departure date).
      city.menuState = x.state.value;
      city.selected = x.location.value;
    }
  }
  c.mode = mode;
  K.calcBtn.setAttribute('aria-pressed', !cmp);
  K.cmpBtn.setAttribute('aria-pressed', cmp);
  K.calcPanel.hidden = K.resultCalc.hidden = cmp;
  K.panel.hidden = K.resultCmp.hidden = !cmp;
  showMessage(c, c.initial, false);
  update(c);
}

// A city row from the template, its State set to st (empty: "Choose a state"), added at the end.
function newCity(c, st) {
  const K = c.cmp;
  const row = clone(K.tpl);
  const x = newDest(hooksIn(row, 'data-pd-city', CITY_HOOKS, { row: row }));
  copyStates(c, x.state);
  x.state.value = st;
  wireDest(c, null, x);
  on(x.remove, 'click', () => removeCity(c, x));
  K.list.appendChild(row);
  K.cities.push(x);
  return x;
}

// Add another city (v1.3 §4): its State prefilled from the previous city. Focus goes to that State.
function addCity(c) {
  const K = c.cmp;
  if (K.cities.length >= MAX_CITIES) return;
  const x = newCity(c, K.cities[K.cities.length - 1].state.value);
  layoutCompare(c);
  x.state.focus();
  update(c);
}

// Remove a city (never below 2); a menu still loading for it is dropped. Focus goes to Add another city.
function removeCity(c, x) {
  const K = c.cmp;
  const i = K.cities.indexOf(x);
  if (i < 0 || K.cities.length < 3) return;
  K.cities.splice(i, 1);
  x.wantMenu = null;
  x.row.parentNode.removeChild(x.row);
  layoutCompare(c);
  K.add.focus();
  update(c);
}

// Compare numbering after any add or remove, from each row's position so ids stay unique: legend
// "City n", its Remove label and pd-city-{n}-… ids. Remove shows from 3 rows; Add another city disables
// and its note shows at 5.
function layoutCompare(c) {
  const K = c.cmp;
  const n = K.cities.length;
  K.cities.forEach((x, i) => {
    const id = 'pd-city-' + (i + 1) + '-';
    setText(x.title, 'City ' + (i + 1));
    x.remove.setAttribute('aria-label', 'Remove city ' + (i + 1));
    x.remove.hidden = n < 3;
    labelled(x.state, id + 'state');
    labelled(x.location, id + 'location');
    // Screen readers hear the row's error with its fields.
    x.status.id = id + 'status';
    x.state.setAttribute('aria-describedby', x.status.id);
    x.location.setAttribute('aria-describedby', x.status.id);
  });
  K.add.disabled = n >= MAX_CITIES;
  if (K.addNote) K.addNote.hidden = n < MAX_CITIES;
}

// Gives a control its id and points the label in its field (else in its parent) at it.
function labelled(el, id) {
  const label = (el.closest('.perdiem-calc_field') || el.parentNode).querySelector('label');
  el.id = id;
  if (label) label.htmlFor = id;
}

// Numbering after any add or remove, from each trip's and destination's position, so ids stay unique:
// trip k >= 2 gets legend "Trip k", its Remove label and pd-t{k}-… ids; destination m gets legend,
// Remove label and pd-dest-{m}-… ids in trip 1, pd-t{k}-dest-{m}-… in trip k. Then the titles that show
// from 2 trips or destinations, and each Add button and its note at the limit.
function layout(c) {
  const e = c.e;
  const n = c.trips.length;
  c.trips.forEach((T, t) => {
    const k = t + 1;
    const id = t ? 'pd-t' + k + '-' : 'pd-';
    if (t) {
      setText(T.title, 'Trip ' + k);
      T.remove.setAttribute('aria-label', 'Remove trip ' + k);
      ['depart', 'return', 'over12', 'state', 'location'].forEach((name) => labelled(T[name], id + name));
      T.status.id = id + 'status';
      T.status1.id = id + 'dest1-status';
    }
    // Screen readers hear a trip's dates line (or its error) with its Departure date, from 2 trips.
    if (T.status) {
      if (!T.status.id) T.status.id = 'pd-trip1-status';
      if (n > 1) T.depart.setAttribute('aria-describedby', T.status.id);
      else T.depart.removeAttribute('aria-describedby');
    }
    T.dests.forEach((x, i) => {
      if (!i) return;
      const m = i + 1;
      setText(x.title, 'Destination ' + m);
      x.remove.setAttribute('aria-label', 'Remove destination ' + m);
      ['arrive', 'state', 'location'].forEach((name) => labelled(x[name], id + 'dest-' + m + '-' + name));
      // Screen readers hear the row's dates (or its error) with its Arrive on field.
      if (x.status) {
        x.status.id = id + 'dest-' + m + '-status';
        x.arrive.setAttribute('aria-describedby', x.status.id);
      }
    });
    if (T.title1) T.title1.hidden = T.dests.length < 2;
    if (T.add) T.add.disabled = T.dests.length >= MAX_DESTINATIONS;
    if (T.addNote) T.addNote.hidden = T.dests.length < MAX_DESTINATIONS;
  });
  if (e.title) e.title.hidden = n < 2;
  if (e.totalLabel) setText(e.totalLabel, n > 1 ? 'All trips total' : c.totalText);
  if (e.addTrip) e.addTrip.disabled = n >= MAX_TRIPS;
  if (e.addTripNote) e.addTripNote.hidden = n < MAX_TRIPS;
}

// A mouse or pen click anywhere in a date field opens the calendar, not only its icon. The pointer
// type comes from the pointerdown before the click: keyboard use (Tab, typing) has none, so it is
// untouched, and touch is skipped because phones open their own picker.
function openPickerOnClick(input) {
  let pointer = '';
  on(input, 'pointerdown', (ev) => { pointer = ev.pointerType; });
  on(input, 'click', () => {
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

function sameDay(T) {
  const d = parseISODate(T.depart.value);
  return d !== null && d === parseISODate(T.return.value);
}

const allDests = (c) => c.trips.reduce((list, T) => list.concat(T.dests), []);

// Date fields take meta.json's first and last covered day (phase-4 spec), in every trip.
function dateBounds(c, T) {
  [T.depart, T.return].forEach((el) => {
    el.min = toISODate(c.range.min);
    el.max = toISODate(c.range.max);
  });
}

// Field state that follows each trip's dates, re-applied on every update: the return date's min, the
// same-day switch (Arrive on hides, keeping its value), and each Arrive on's min (the previous
// destination's date + 1) and max (return − 1). Typed dates bypass min/max; validateTrip still checks them.
function sync(c) {
  const bound = (day, edge) => (day !== null ? toISODate(day) : c.range ? toISODate(c.range[edge]) : '');
  c.trips.forEach((T) => {
    const d = parseISODate(T.depart.value);
    const r = parseISODate(T.return.value);
    const same = sameDay(T);
    if (c.range) T.return.min = d !== null && (r === null || r < d) ? T.depart.value : toISODate(c.range.min);
    if (T.over12Wrap) T.over12Wrap.hidden = !same;
    let prev = d;
    T.dests.forEach((x, i) => {
      if (!i) return;
      x.arriveField.hidden = same;
      x.arrive.min = bound(prev !== null ? prev + 1 : null, 'min');
      x.arrive.max = bound(r !== null ? r - 1 : null, 'max');
      const a = parseISODate(x.arrive.value);
      if (a !== null) prev = a;
    });
  });
  renderStatus(c);
  if (c.cmp) syncCompare(c);
}

// The same for the Compare fields (v1.3 §4): the return date's min, the same-day switch, and each city's
// error line.
function syncCompare(c) {
  const K = c.cmp;
  const d = parseISODate(K.depart.value);
  const r = parseISODate(K.return.value);
  if (c.range) K.return.min = d !== null && (r === null || r < d) ? K.depart.value : toISODate(c.range.min);
  if (K.over12Wrap) K.over12Wrap.hidden = !sameDay(K);
  renderCompareStatus(c);
}

// Exactly one field, the one an error is about (target), gets aria-invalid; null entries are skipped.
function markInvalid(fields, target) {
  fields.forEach((f) => {
    if (!f) return;
    if (f === target) f.setAttribute('aria-invalid', 'true');
    else f.removeAttribute('aria-invalid');
  });
}

// A compare error (not a prompt) shows on its city's line in red (is-error) and marks its field; an error
// about the dates marks that date. The bottom message repeats it (v1.3 §4, the v1.1 pattern).
function renderCompareStatus(c) {
  const K = c.cmp;
  const err = K.err;
  const fields = [K.depart, K.return];
  K.cities.forEach((x, i) => {
    const own = !!err && err.city === i;
    setText(x.status, own ? err.error : '');
    x.status.hidden = !own;
    x.status.classList.toggle('is-error', own);
    fields.push(x.state, x.location);
  });
  markInvalid(fields, err && err.field ? (err.city === null ? K : K.cities[err.city])[err.field] : null);
}

// The lines under the titles. Each destination's (2+ destinations in its trip): the error about it,
// else the dates and nights it covers on an overnight trip (v1.1 §17). Each trip's (2+ trips): its
// other errors (dates, overlap, and a one-destination trip's), else its dates line (v1.2 §4). The field
// an error is about gets aria-invalid, which the CSS shows in red. One trip shows exactly v1.1.
function renderStatus(c) {
  const err = c.err;
  const plan = c.trips.length > 1;
  const fields = [];
  let target = null;
  c.trips.forEach((T, t) => {
    const mine = err && (err.trip || 0) === t ? err : null;
    const several = T.dests.length > 1;
    const onDest = !!mine && several && mine.dest !== null && mine.dest !== undefined;
    const spans = several && !sameDay(T)
      ? destinationSpans(T.depart.value, T.return.value, T.dests.map((x) => (x.arrive ? x.arrive.value : '')))
      : [];
    T.dests.forEach((x, i) => {
      const el = i ? x.status : T.status1;
      if (!el) return;
      const own = onDest && mine.dest === i;
      const text = own ? mine.error : spans[i] ? spanText(spans[i]) : '';
      setText(el, text);
      el.hidden = !text;
      el.classList.toggle('is-error', own);
    });
    if (T.status) {
      const own = plan && !!mine && !onDest;
      const text = own ? mine.error : plan ? tripDatesText(T.depart.value, T.return.value, T.dests.length) : '';
      setText(T.status, text);
      T.status.hidden = !text;
      T.status.classList.toggle('is-error', own);
    }
    if (mine && mine.field) {
      target = mine.dest === null || mine.dest === undefined ? T[mine.field] : T.dests[mine.dest][mine.field];
    }
    fields.push(T.depart, T.return);
    T.dests.forEach((x) => fields.push(x.arrive, x.state, x.location));
  });
  markInvalid(fields, target);
}

// Errors (not "Choose …" prompts) are marked on their trip, destination and field.
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
  // Compare mode (v1.3) runs the same steps on its own dates and city rows.
  const K = c.mode === 'compare' ? c.cmp : null;
  // Errors are re-checked on every change (compute marks them again if they remain).
  c.err = null;
  if (K) K.err = null;
  sync(c);
  // A state is chosen (preselected on state pages, prefilled on new rows) but its menu isn't built yet.
  const pending = (x) => x.state.value && (!x.menuKey || x.menuKey.indexOf(x.state.value + '/') !== 0);
  const dests = K ? K.cities : allDests(c);
  if (!loaded(META_URL)) {
    dests.forEach((x) => { if (pending(x)) setOptions(x, [{ value: '', label: 'Loading…' }], '', true); });
  }
  load(META_URL)
    .then((meta) => {
      if (!current()) return;
      if (!c.range) {
        c.range = availableRange(meta);
        c.trips.concat(c.cmp || []).forEach((T) => dateBounds(c, T));
        sync(c);
      }
      // Compare: every city's menu uses the fiscal year of the shared departure date.
      if (K) {
        return Promise.all(K.cities.map((x) => (x.state.value ? ensureMenu(c, x, x.state.value,
          menuFiscalYear(meta, K.depart.value, todayIso())) : clearMenu(x))))
          .then(() => { if (current()) return computeCompare(c, meta, current); });
      }
      // Each menu uses the fiscal year of its destination's start: its trip's departure date for
      // destination 1 and on same-day trips, else its Arrive on date, else the departure date.
      return Promise.all(c.trips.map((T) => {
        const same = sameDay(T);
        return Promise.all(T.dests.map((x, i) => {
          const st = x.state.value;
          if (!st) return clearMenu(x);
          const start = i && !same && parseISODate(x.arrive.value) !== null ? x.arrive.value : T.depart.value;
          return ensureMenu(c, x, st, menuFiscalYear(meta, start, todayIso()));
        }));
      })).then(() => { if (current()) return compute(c, meta, current); });
    })
    .catch((err) => {
      if (!current()) return;
      console.warn('[perdiem]', err);
      // Menus that failed say so themselves; this covers the ones meta.json never let start.
      dests.forEach((x) => {
        if (pending(x) && !x.wantMenu) setOptions(x, [{ value: '', label: 'Rates couldn’t load' }], '', true);
      });
      const tableBelow = c.pre && c.pre === (K ? K.cities[0] : c.e).state.value;
      showMessage(c, LOAD_ERROR + (tableBelow ? ' The full rate table is below.' : ''), true);
    });
}

// One trip's fields as calculateTrip reads them (without meta and files).
function tripInput(T) {
  return {
    departIso: T.depart.value, returnIso: T.return.value, over12: T.over12 ? T.over12.checked : undefined,
    destinations: T.dests.map((x) => ({ state: x.state.value, location: x.location.value,
      arrive: x.arrive ? x.arrive.value : null, stateName: stateName(x) }))
  };
}

// The "don't re-fire for the same inputs" key of one trip: its dates, switch and every destination.
function tripKey(trip) {
  return [trip.departIso, trip.returnIso, trip.over12].concat(trip.destinations.map((x) =>
    [x.state, x.location, x.arrive].join('/'))).join('|');
}

// { [fy]: { [ST]: data } } from [fy, ST] pairs and their loaded files, in the same order.
function filesFor(needed, list) {
  const files = {};
  needed.forEach((p, i) => { (files[p[0]] = files[p[0]] || {})[p[1]] = list[i]; });
  return files;
}

// The whole form, as a plan (v1.2 spec §3): every trip in entry order, then the overlap check. A lone
// trip gives exactly the v1.1 result (calculatePlan returns calculateTrip's), with v1.1's own prompts for
// empty dates, summary line, export and the v1.0.1 wording of a rate gap at one destination.
function compute(c, meta, current) {
  const plan = { meta: meta, trips: c.trips.map(tripInput) };
  const one = plan.trips.length < 2 && plan.trips[0];
  const d = one && one.departIso;
  const r = one && one.returnIso;
  if (one && !d && !r) return showMessage(c, c.initial, false);
  if (one && !d) return showMessage(c, 'Choose your departure date', false);
  if (one && !r) return showMessage(c, 'Choose your return date', false);

  // Exactly the state files the calculation reads (up to the first trip that fails without data). Don't
  // leave the previous result on screen while one loads.
  const needed = planNeeded(plan, meta);
  const urls = needed.map((p) => stateUrl(p[0], p[1]));
  if (!urls.every(loaded)) showMessage(c, c.initial, false);
  return Promise.all(urls.map(load)).then((list) => {
    if (!current()) return;
    plan.files = filesFor(needed, list);
    const res = calculatePlan(plan);
    if (!res.ok) {
      setError(c, res);
      return showMessage(c, one && res.rateGap && one.destinations.length === 1 ? MESSAGES.locationGap : res.error,
        !res.incomplete);
    }
    const t = res.trips[0];
    const x = one ? { res: t, summary: tripSummaryText(t, d, r), empty: t.tripType === 'day_short',
      csv: (today) => buildCsv(t, d, r, today) }
      : { res: res, summary: planSummaryText(res), empty: allShort(res), csv: (today) => buildPlanCsv(res, today) };
    x.key = plan.trips.map(tripKey).join('||');
    x.params = planAnalyticsParams(res);
    showResult(c, x);
  });
}

// Compare mode (v1.3 §3, §5): every city on the shared dates and switch, side by side, nothing added up.
// Both dates empty keep the opening message, as in Calculate; the rest of the checks are calculateCompare's.
function computeCompare(c, meta, current) {
  const K = c.cmp;
  const d = K.depart.value;
  const r = K.return.value;
  const cmp = { meta: meta, departIso: d, returnIso: r, over12: K.over12 ? K.over12.checked : undefined,
    cities: K.cities.map((x) => ({ state: x.state.value, location: x.location.value, stateName: stateName(x) })) };
  if (!d && !r) return showMessage(c, c.initial, false);
  const needed = compareNeeded(cmp, meta);
  const urls = needed.map((p) => stateUrl(p[0], p[1]));
  if (!urls.every(loaded)) showMessage(c, c.initial, false);
  return Promise.all(urls.map(load)).then((list) => {
    if (!current()) return;
    cmp.files = filesFor(needed, list);
    const res = calculateCompare(cmp);
    if (!res.ok) {
      K.err = res.incomplete ? null : res;
      renderCompareStatus(c);
      return showMessage(c, res.error, !res.incomplete);
    }
    showResult(c, { res: res, lines: compareLines(res), summary: compareSummaryText(res, d, r),
      empty: !res.cities.some((t) => t.total > 0), event: 'perdiem_compare', params: compareAnalyticsParams(res),
      key: ['compare', d, r, cmp.over12].concat(cmp.cities.map((x) => x.state + '/' + x.location)).join('|'),
      csv: (today) => buildCompareCsv(res, d, r, today) });
  });
}

// A valid result x { res, summary, empty, key, params, csv(todayIso) }: the five boxes (plan totals for
// 2+ trips) and the breakdown, or in Compare mode (x.lines, x.event) the city list; then the summary line
// and Export, then the calculate (or compare) event. Nothing to export (empty) is a valid $0 result: a day
// trip of 12 hours or less, a plan of only such trips, or a comparison of one.
function showResult(c, x) {
  const e = c.e;
  const res = x.res;
  if (x.lines) {
    renderCompare(c, x.lines);
  } else {
    setText(e.days, String(res.days));
    setText(e.total, formatMoney(res.total));
    setText(e.lodging, formatMoney(res.lodging));
    setText(e.meals, formatMoney(res.meals));
    setText(e.incidentals, formatMoney(res.incidentals));
    renderBreakdown(c, res);
  }
  setText(e.message, x.summary);
  e.message.classList.remove('is-error');
  e.export.disabled = x.empty;
  c.result = x;
  scheduleCalculateEvent(c);
}

function clearResults(c) {
  const e = c.e;
  setText(e.days, '0');
  ['total', 'lodging', 'meals', 'incidentals'].forEach((k) => setText(e[k], '$0'));
  e.export.disabled = true;
  renderBreakdown(c, null);
  renderCompare(c, []);
  c.result = null;
  clearTimeout(c.timer);
}

// Compare result list (v1.3 §5), cloned from its template: one line per city in entry order with its
// lodging and M&IE line and its total; the lowest city or cities get is-lowest and the Lowest badge (text,
// never colour alone).
function renderCompare(c, lines) {
  const K = c.cmp;
  if (!K) return;
  const list = K.results;
  while (list.firstChild) list.removeChild(list.firstChild);
  lines.forEach((l) => {
    const li = document.importNode(K.line, true);
    const item = (n) => li.querySelector('[data-pd-item="' + n + '"]');
    item('place').textContent = l.place;
    item('dates').textContent = l.detail;
    item('amount').textContent = formatMoney(l.amount);
    item('badge').hidden = !l.lowest;
    li.classList.toggle('is-lowest', l.lowest);
    list.appendChild(li);
  });
}

// Result breakdown, cloned from the templates (v1.1 §17, v1.2 §4). One trip: a line per destination of an
// overnight trip with 2+ destinations ("By destination"). 2+ trips: a line per trip from the trip line
// template ("By trip"), each followed by its destination lines, indented (is-sub); without that template
// the list stays hidden.
function renderBreakdown(c, res) {
  if (!c.line) return;
  const e = c.e;
  const plan = !!res && !!res.trips;
  const lines = res && (!plan || c.tripLine) ? breakdownLines(res) : [];
  const list = e.breakdownList;
  while (list.firstChild) list.removeChild(list.firstChild);
  lines.forEach((l) => {
    const li = document.importNode(plan && !l.sub ? c.tripLine : c.line, true);
    const item = (n) => li.querySelector('[data-pd-item="' + n + '"]');
    if (l.sub) li.classList.add('is-sub');
    item('place').textContent = l.place;
    item('dates').textContent = l.dates;
    item('amount').textContent = formatMoney(l.amount);
    list.appendChild(li);
  });
  if (e.breakdownTitle) setText(e.breakdownTitle, plan ? 'By trip' : c.byDest);
  e.breakdown.hidden = !lines.length;
}

function showMessage(c, text, isError) {
  clearResults(c);
  setText(c.e.message, text);
  c.e.message.classList.toggle('is-error', isError);
}

// perdiem_calculate (perdiem_compare in Compare mode, v1.3 §8): once per distinct valid result, after the
// inputs settle for 1.5 s.
function scheduleCalculateEvent(c) {
  clearTimeout(c.timer);
  const key = c.result.key;
  if (c.fired[key]) return;
  c.timer = setTimeout(() => {
    if (!c.result || c.result.key !== key) return;
    c.fired[key] = true;
    track(c.result.event || 'perdiem_calculate', c.result.params);
  }, 1500);
}

function exportCsv(c) {
  const x = c.result;
  if (!x || x.empty) return;
  const csv = x.csv(todayIso());
  const url = URL.createObjectURL(new Blob([csv.text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = csv.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  // With Compare cities on, the export says which mode it came from (v1.3 §8); v1.2 markup: as v1.2.0.
  track('perdiem_export', c.cmp ? Object.assign({}, x.params, { mode: c.mode }) : x.params);
}

function start() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-perdiem-calc]'), init);
}

window.ItilitePerDiem = { base: BASE, cache: cache, calculate: calculate, calculateTrip: calculateTrip,
  calculatePlan: calculatePlan, calculateCompare: calculateCompare, validateDates: validateDates };
if (document.readyState === 'loading') on(document, 'DOMContentLoaded', start);
else start();

# Phase 4 — Calculator script (specification)

> Save as `docs/phase-4-calculator.md` in the repo. `CLAUDE.md`'s "Calculator maths" section points here.
> Everything below is **locked** unless marked *(verify)*. Propose before changing anything else.

## What the script does

The Webflow pages already contain the full calculator markup (fields, result boxes, Export button).
The script adds behaviour only:

1. Fills the **City or county** menu for the chosen state.
2. Reads the GSA rates for the travel dates from this repo's data files.
3. Calculates lodging, meals, incidentals, total and days, and writes them into the result boxes.
4. Enables **Export to Excel** (a CSV download) and fires two GA4 events.

It runs on 50 pages: `/per-diem-calculator` (no state preselected) and 49 state pages (state preselected).

## Files

```
src/calc-core.js        pure calculation functions, no DOM (tested with node --test)
src/perdiem.js          DOM wiring: reads hooks, loads data, renders, export, analytics
scripts/build-js.js     zero-dependency build: wraps calc-core + perdiem into one IIFE → dist/perdiem.js
test/calc-core.test.js  golden tests (below)
dist/perdiem.js         built file, committed
```

- Zero npm dependencies (repo rule). No bundler, no minifier.
- Minification: jsDelivr serves an auto-minified copy when a `.min.js` file is requested that doesn't
  exist in the repo, so the page loads `dist/perdiem.min.js` while the repo only has `dist/perdiem.js`
  *(verify on the first tag; if jsDelivr doesn't, serve `perdiem.js` unminified — it's small)*.
- Output: one IIFE, `'use strict'`, no globals except `window.ItilitePerDiem` (for debugging only).
- Size target: under 15 KB as served (minified). `npm run build:js` prints an upper-bound estimate
  (comments and whitespace stripped, no renaming) and warns above 15 KB; confirm the real
  `perdiem.min.js` size on the first tag.
- Browser support: current evergreen browsers. No transpiling; avoid syntax newer than ES2019.

## Hook contract (already in the Webflow markup — do not rename)

| Selector | Element | Role |
|---|---|---|
| `[data-perdiem-calc]` | calculator card | root; one per page. `data-state` = two-letter code or empty |
| `[data-pd="depart"]` | `<input type="date">` | departure date |
| `[data-pd="return"]` | `<input type="date">` | return date |
| `[data-pd="state"]` | `<select>` | 49 options already in the HTML, values = codes (`CA`, `DC`…) |
| `[data-pd="location"]` | `<select>` | starts `disabled` with "Choose a state first" |
| `[data-pd="message"]` | `<p role="status" aria-live="polite">` | one-line status / summary / error |
| `[data-pd="export"]` | `<button disabled>` | CSV export |
| `[data-pd="days"]` | `<dd>` | e.g. `3` |
| `[data-pd="total"]`, `lodging`, `meals`, `incidentals` | `<dd>` | money |

Error styling: add class `is-error` to the message element; remove it when the error clears.
Nothing else in the markup may be changed by the script (no injected layout, no inline styles).

## Data

- Base URL = the folder the script itself was loaded from, one level up from `dist/`
  (derive from `document.currentScript.src`). Code and data then always come from the **same tag**.
  Fallback constant: `https://cdn.jsdelivr.net/gh/marketing235/itilite-per-diem@v1.0.0/` (update it
  with each release tag).
- `data/meta.json` → fiscal years available, their `effective` / `expires` dates.
- `data/{fy}/{ST}.json` → `standard` (`{lodging, mie}` or `null` for DC) and `locations[]`
  (`did`, `county`, `city`, `mie`, `lodging[12]` in calendar order Jan–Dec).
- Load lazily: nothing is fetched until the calculator is near the viewport (IntersectionObserver,
  `rootMargin: "400px"`) or a field receives focus. `meta.json` first, then state files on demand.
- Cache every fetched file in memory for the page view. Fetch each file at most once.
- On a state page, preselect `data-state` in the State menu and load that state's files when the
  calculator comes near the viewport.

## Calculation rules (locked)

Dates are **calendar dates, not times**. Parse `YYYY-MM-DD` manually and do all arithmetic in UTC
(`Date.UTC`). Never use `new Date('YYYY-MM-DD')` with local-time methods — it shifts by a day in some
time zones.

1. **Days** = inclusive calendar days, departure to return. Same-day trip = 1 day.
2. **Nights** = days − 1. Each night uses the lodging rate for **that night's calendar month**
   (`lodging[month]`). A same-day trip has no lodging.
3. **Fiscal year per date**: 1 Oct–30 Sep, `fy = month >= Oct ? year + 1 : year`. Each night and each
   day uses the data file of its own fiscal year.
4. **M&IE per day** = the location's `mie` for that day's fiscal year. The **first and last day** get
   75% of it. A same-day trip is a single 75% day.
5. **Incidentals** = $5 per full day, and $3.75 (75% of $5) on the first and last day.
   **Meals** = that day's M&IE minus that day's incidentals. (Meals + incidentals always = M&IE.)
6. **Location**: the menu's value is a `did` or `std`.
   - Menu options: the state's `locations` sorted A–Z by `city` text, then
     `All other {State name} locations (standard rate)` with value `std`.
   - DC: `standard` is `null` → no `std` option; its one location is preselected.
   - A state with no locations (North Dakota) → only the `std` option, preselected.
   - Build the menu from the fiscal year of the departure date (today's fiscal year if no date yet).
     If the dates change fiscal year, rebuild it and keep the selection when the same `did` exists.
   - If the chosen `did` doesn't exist in a fiscal year the trip touches (e.g. a place that moved to
     the standard rate), use that year's `standard` for those dates. If `standard` is `null` there too,
     show the error "Rates for this location aren't available for all of your dates."
7. **Money**: keep cents. 75% days produce .25/.50/.75 values. Format with
   `Intl.NumberFormat('en-US', {style:'currency', currency:'USD'})`, showing cents only when the
   amount isn't a whole dollar (`$788`, `$55.50`). Sum exact values; never round intermediate steps.
8. **Limits**: return before departure → error "Your return date is before your departure date."
   Any date outside the fiscal years in `meta.json` → error "Rates for {Month YYYY} aren't published
   yet." (or "…are no longer available" for dates before the earliest year). Maximum trip 365 days.

## Behaviour

- **No Calculate button.** Recalculate automatically whenever a field changes and all four fields are
  valid. Until then, results show `0` / `$0` and the message says what's missing
  ("Choose your return date", "Choose a city or county").
- Location menu: disabled with "Loading…" while a state file loads; then enabled with a first option
  "Choose a city or county" (value empty) unless preselected by rule 6.
- Changing the state clears the location and results.
- Summary in the message after a valid calculation, for example:
  `3 days in San Francisco, 1–3 Oct 2026. Total allowance $788.`
- Fetch failure: message "Rates couldn't load. Please try again." with `is-error`; on state pages add
  "The full rate table is below."; retry the fetch next time the user changes a field.
- Date inputs: set `min` / `max` from `meta.json` (earliest `effective`, latest `expires`).
  When the departure date is set and the return date is empty or earlier, set return `min` to it.

## Export (CSV, opens in Excel)

- Enabled only while a valid result is shown.
- UTF-8 with BOM (so Excel reads the en dash and `$` correctly), CRLF line endings, every field quoted.
- Filename: `per-diem-{state}-{YYYY-MM-DD}-to-{YYYY-MM-DD}.csv`.
- Content:
  - Header lines: `ITILITE per diem estimate`, location (`{city}, {State}` or `Standard rate, {State}`),
    travel dates, `Source: U.S. General Services Administration per diem rates`, `Generated {date}`.
  - One row per day: `Date, Fiscal year, Lodging, Meals, Incidentals, Day total` (lodging on each night's
    row, none on the last day).
  - A totals row.
- Guard against spreadsheet formula injection: prefix a `'` to any cell starting with `=`, `+`, `-`, `@`.
- Download via `Blob` + temporary `<a download>`; revoke the object URL afterwards.

## Analytics (GA4 `G-K26RX2PTFK`, via the page's existing `gtag`)

- `perdiem_calculate` with params `state` (code), `location_type` (`nsa` | `standard`), `days` (number).
  Fire once per distinct valid result (debounce 1.5 s; don't re-fire for the same inputs).
- `perdiem_export` with the same params, on each export click.
- If `window.gtag` is missing, push nothing and don't error. Never send dates, city names or anything
  typed by the user.

## Accessibility

- All updates go through the existing `aria-live` message; don't add another live region.
- Never move focus automatically. Keyboard-only use must work end to end.
- `disabled` states on the location menu and Export button must match what's usable.

## Golden tests (`node --test`, against the committed data files)

| # | Trip | Expected |
|---|---|---|
| 1 | San Francisco CA (did 35), 1 Oct 2026 → 3 Oct 2026 | days 3 · lodging $558 (2 × $279) · M&IE $230 (69 + 92 + 69) · incidentals $12.50 · meals $217.50 · total $788 |
| 2 | Washington DC, 1 Mar 2027 → 4 Mar 2027 | days 4 · lodging $885 (3 × $295) · M&IE $322 · total $1,207 |
| 3 | Wilmington DE (did 78), 5 Oct 2026, same day | days 1 · lodging $0 · M&IE $55.50 (matches GSA's first/last-day figure for Wilmington) · total $55.50 |
| 4 | North Dakota, standard, 10 Oct 2026 → 11 Oct 2026 | days 2 · lodging $113 · M&IE $102 (51 + 51) · total $215 |
| 5 | San Francisco CA (did 35), 29 Sep 2026 → 2 Oct 2026 (crosses fiscal years) | days 4 · lodging $823 (29 and 30 Sep at FY2026's September $272, 1 Oct at FY2027's $279) · M&IE $322 (69 + 92 + 92 + 69) · incidentals $17.50 · meals $304.50 · total $1,145 |
| 6 | Allentown PA (FY2026 did 307), 28 Sep 2026 → 2 Oct 2026 | days 5 · lodging $458 (3 × $115, then 1 Oct at the FY2027 standard $113, because Allentown has no FY2027 rate) · M&IE $322.50 (55.50 + 74 + 74 + 68 + 51) · total $780.50 |
| 7 | Return before departure | error, no result |
| 8 | Any date after 30 Sep 2027 | "not published yet" error |
| 9 | Date parsing | `2026-10-01` is October 1 in any time zone (run the test with `TZ=America/Los_Angeles` and `TZ=Asia/Kolkata`) |

## Release

1. All tests pass → `npm run build:js` → commit `dist/perdiem.js`. (`npm run build` is the county-table
   build from Phase 1.)
2. Tag `v1.0.0` and push the tag. Tags are exact semver. The live site only ever loads one exact
   tag — **never `@v1`** (jsDelivr may resolve it as a version range) and **never `@main`**.
3. Webflow (manual, by Ashique): add to the **Per diem styles** component, after the `<style>` block:
   `<script src="https://cdn.jsdelivr.net/gh/marketing235/itilite-per-diem@v1.0.0/dist/perdiem.min.js" defer></script>`
   The component is on both pages, so one tag covers all 50.
4. Later fixes: tag `v1.0.1`, `v1.0.2`… (bump `FALLBACK_BASE` in `src/perdiem.js` to match, rebuild)
   and update the one script tag to the new exact tag. Data refreshes (August) get a new tag the same
   way, so code and data stay in step.

## Out of scope

Multi-trip ("add another trip"), saving trips, Alaska/Hawaii/international rates, gating the export
behind a form, a date-range picker library.

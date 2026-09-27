# ITILITE Per Diem — project brief for Claude Code

> **First action every session:** read this file fully. Verify anything marked *(verify)*
> against the real GSA response before relying on it, and correct this file if it drifts.
> Decisions in the "Locked decisions" section are settled — do not reopen them.

## What this is

Data and front-end code for two ITILITE web pages:

- `https://www.itilite.com/per-diem-calculator` — a free US per diem calculator (static Webflow page)
- `https://www.itilite.com/per-diem-calculator/{state}` — 49 state pages (Webflow CMS collection)

The pages themselves are built in Webflow by Ashique. **This repo only produces three things:**

1. **Data files** — GSA per diem rates as small static JSON, one file per state per fiscal year
2. **Calculator JavaScript** — vanilla, loaded by the Webflow page from jsDelivr
3. **SVG map** — clickable US map, injected by the same JavaScript

Files are served to the site through jsDelivr: `https://cdn.jsdelivr.net/gh/marketing235/itilite-per-diem@<tag>/...`
Never assume a file is reachable until it is committed and tagged.
**Tags are exact semver (`v1.0.0`, `v1.0.1`, …) and the live script URL pins one exact tag** —
never `@v1` (jsDelivr may treat it as a version range) and never `@main`. The first release is `v1.0.0`.

## Why the data is pulled once, not called live

GSA's API needs a key and allows 1,000 requests per hour per key. Calling it from visitors' browsers
would expose the key and share one limit across all traffic. Rates change once a year (published
mid-August, effective 1 October). So: pull once, commit static JSON, serve from CDN. The state pages
also need the rates as server-rendered HTML for SEO, which only a pre-pull can provide.

## Locked decisions

| # | Decision |
|---|---|
| 1 | URLs: `/per-diem-calculator` (static) and `/per-diem-calculator/{state-slug}` (CMS) |
| 2 | Scope: 48 contiguous states + District of Columbia = 49. Alaska and Hawaii are **out** (not in GSA CONUS data); drawn greyed and unlinked on the map |
| 3 | Dates: two native `<input type="date">` fields (departure, return). No date-picker library |
| 4 | Export: CSV generated in the browser with a Blob download, button labelled "Export to Excel". No SheetJS |
| 5 | Export is ungated (no HubSpot form) |
| 6 | Calculation rules — see "Calculator maths" below and `docs/phase-4-calculator.md` |
| 7 | State-page county table shows **special-rate GSA locations only** plus one "all other locations: standard rate" line |
| 8 | Hosting: this repo + jsDelivr. GitHub account `marketing235` (personal, known caveat) |
| 9 | Both FY2026 and FY2027 data shipped from day one; the calculator picks the fiscal year per travel day |

## Stack and constraints (same rules as `itilite-health` and `itilite-page-performance`)

- **Node 22, ESM (`"type": "module"`), zero npm dependencies.** Use built-in `fetch`, `fs`, `path`.
  Adding a dependency needs a written justification in the PR.
- **Never commit secrets.** The GSA key lives only in `.env` (`GSA_API_KEY=...`) locally and in a
  GitHub Actions secret. `.env` and `fixtures/raw-*.json` are gitignored. Create `.gitignore` first.
- **Front-end JS is vanilla, IIFE-wrapped, no jQuery, no frameworks.** Script weight matters for
  Core Web Vitals; target under 15 KB as served (minified) for the calculator (`perdiem.min.js`).
- **Fail loud.** Any script that cannot complete must exit non-zero with a clear message. Never write
  partial data.
- **Propose before building.** For anything not specified here, describe the approach and ask before
  writing code.

## Target repo map

```
CLAUDE.md
package.json                  "type": "module", scripts: pull, build, build:js, test
.gitignore                    .env, node_modules, fixtures/raw-*.json, dist/*.map
.env.example                  GSA_API_KEY=
scripts/pull-gsa.js           Phase 1 — fetch GSA, write data/, cms/
scripts/build-tables.js       Phase 1 — write cms/tables/{fy}/{ST}.html from data/
scripts/lib/states.js         the 49-state list below, exported
data/meta.json
data/{fy}/{ST}.json           e.g. data/2027/CA.json
cms/states.csv                Webflow CMS import file
cms/tables/{fy}/{ST}.html     county-table HTML snippet per state (Webflow field type decided later)
docs/phase-4-calculator.md    Phase 4 — calculator spec (locked)
src/calc-core.js              Phase 4 — pure calculation functions, no DOM
src/perdiem.js                Phase 4 — DOM wiring: hooks, data loading, render, export, analytics
scripts/build-js.js           Phase 4 — zero-dependency build: wraps calc-core + perdiem into one IIFE
test/calc-core.test.js        Phase 4 — golden tests against the committed data/ files
test/fixtures/03-calculator.html  calculator markup as it appears in Webflow (hook contract)
scripts/serve.js              Phase 4 — local static server (node:http) with an HTML include swap
test/harness.html             Phase 4 — local main-page harness (npm run serve)
test/harness-state.html       Phase 4 — local state-page harness, data-state="CA"
src/us-map.svg                Phase 5 — map source
dist/perdiem.js               built output, committed; the page requests perdiem.min.js, which jsDelivr auto-minifies
dist/us-map.svg
fixtures/raw-conus-lodging-{fy}.json   one raw GSA response per FY kept locally for reference (gitignored)
.github/workflows/pull.yml    Phase 8 — annual run, 20 August
```

## GSA API

- Docs: https://open.gsa.gov/api/perdiem/
- Endpoint used: `https://api.gsa.gov/travel/perdiem/v2/rates/conus/lodging/{FY}` — one request
  returns **every state's** locations for that fiscal year, so a full pull is only 2 requests
  (FY2026, FY2027), not per-state. The per-state endpoint
  (`/rates/state/{ST}/year/{FY}`) is not used.
- Auth: send the key as HTTP header `x-api-key`. Confirmed working.
- Limit: 1,000 requests/hour — not a constraint at 2 requests per pull. Still add a 300 ms pause
  and retry once on 429 or 5xx after a 5 s wait, in case of a partial/paginated response.
- Fiscal year: FY2027 runs 1 Oct 2026 – 30 Sep 2027. **Store lodging in calendar order Jan–Dec**
  (index 0 = January). In an FY2027 file this means Oct–Dec are 2026 calendar months and Jan–Sep
  are 2027 calendar months — the array is calendar order, not fiscal order.
- **Response shape (confirmed from a real fetch):** the endpoint returns an array of location rows
  (or `{ rates: [...] }` wrapping the array — handle both). Each row:
  ```json
  {
    "Jan": "325", "Feb": "325", "Mar": "325", "Apr": "232", "May": "232", "Jun": "232",
    "Jul": "232", "Aug": "232", "Sep": "279", "Oct": "279", "Nov": "279", "Dec": "279",
    "Meals": "92", "City": "San Francisco", "State": "CA", "County": "San Francisco", "DID": "35"
  }
  ```
  - All numeric fields (`Jan`..`Dec`, `Meals`) arrive as **strings** — convert to integers.
  - `County` and `City` are free text as GSA gives them, **kept as-is, not split**. One GSA location
    can span several counties (e.g. `County: "Los Angeles / Orange / Ventura / Edwards AFB less the
    city of Santa Monica"`, `City: "Los Angeles"`) — this is one row, not split into per-county rows.
  - `DID` is GSA's location id (string). Every state has exactly one row per fiscal year with
    `City: "Standard Rate"` and `County: null` — that is the state's standard rate, not a real
    location. Its `DID` is `"0"` in every state observed so far *(verify this holds across all 49
    if a state ever shows otherwise)*.
    **Exception: DC has no "Standard Rate" row at all**, in either fiscal year — its single GSA
    location (`City: "District of Columbia"`) covers the whole area, so there is no leftover region
    to carry a standard rate. See `data/{fy}/DC.json` below.
  - There is also a `standardRate` field (string `"true"`/`"false"`) but it was observed `"false"`
    on every row, including the actual `City: "Standard Rate"` row — **it is unreliable and ignored.
    Use `City === "Standard Rate"` to detect the standard row instead.**
  - No ZIP field is used (not present on this endpoint).

## Output file shapes

### `data/meta.json`
```json
{
  "pulledAt": "2026-09-27",
  "fiscalYears": {
    "2026": { "standard": { "lodging": 110, "mie": 68 }, "effective": "2025-10-01", "expires": "2026-09-30" },
    "2027": { "standard": { "lodging": 0,   "mie": 0  }, "effective": "2026-10-01", "expires": "2027-09-30" }
  },
  "incidentals": 5,
  "source": "https://www.gsa.gov/travel/plan-book/per-diem-rates"
}
```
(The FY2027 standard values above are placeholders; the script fills them from GSA.)

### `data/{fy}/{ST}.json`
```json
{
  "state": "CA",
  "fiscalYear": 2027,
  "standard": { "lodging": 113, "mie": 68 },
  "locations": [
    { "did": "22", "county": "Los Angeles / Orange / Ventura / Edwards AFB less the city of Santa Monica",
      "city": "Los Angeles", "mie": 86,
      "lodging": [199,199,199,199,199,199,199,199,199,199,199,199] },
    { "did": "35", "county": "San Francisco", "city": "San Francisco", "mie": 92,
      "lodging": [325,325,325,232,232,232,232,232,279,279,279,279] }
  ]
}
```
- One row per GSA location, keyed by `did` (GSA's `DID`, kept as a string). **Not** split by county —
  `county` and `city` are GSA's raw text, unchanged, even when a `county` string names several
  counties.
- `locations` holds only the special-rate rows: the row where `City === "Standard Rate"` is excluded
  from `locations` and becomes the top-level `standard` object instead (`lodging`/`mie` as integers).
  Every state file must contain exactly one such row before this split happens (see safety rules);
  `locations` itself may legitimately be empty if a state has no special-rate areas.
- `lodging` is always 12 integers in **calendar order Jan–Dec** (index 0 = January), converted from
  GSA's string values. In an FY2027 file, indices 9–11 (Oct–Dec) are 2026 calendar months and indices
  0–8 (Jan–Sep) are 2027 calendar months.
- `locations` sorted A–Z by `city` (GSA's raw text, byte/locale sort — punctuation sorts as given,
  no normalization).
- **DC exception:** `data/{fy}/DC.json` has `"standard": null`. DC's one GSA location goes into
  `locations` like any special-rate row (it is not treated as a standard-rate row, since it isn't
  labelled `"Standard Rate"`). Every other state must have a non-null `standard`.

### `cms/states.csv`
Columns: `Name,Slug,Abbreviation,Region,Featured,County table HTML` — 49 rows, in the order of the
state list below. Every field is quoted, with embedded double quotes doubled (standard CSV); the
`County table HTML` field's line breaks are kept as literal newlines inside the quoted field. That
column carries each state's **FY2027** `cms/tables/2027/{ST}.html` content verbatim, so a single
CSV import can seed the Webflow CMS collection's county-table field alongside the other columns.
A future pull's later fiscal year does not change which FY populates this column until this file
says so.

### `cms/tables/{fy}/{ST}.html`
Plain HTML, no inline styles, no scripts. Structure *(the exact Webflow field type — rich text vs
plain text inserted into an Embed — is decided in Phase 2 after a paste test; keep the output easy
to transform)*:

```html
<table class="perdiem_table">
  <thead><tr><th>City</th><th>County</th><th>Lodging (per night)</th><th>M&amp;IE (per day)</th><th>Total</th></tr></thead>
  <tbody>
    <tr><td>Los Angeles</td><td>Los Angeles / Orange / Ventura / Edwards AFB less the city of Santa Monica</td><td>$199</td><td>$86</td><td>$285</td></tr>
    <tr><td>San Francisco</td><td>San Francisco</td><td>$232–$325</td><td>$92</td><td>$324–$417</td></tr>
  </tbody>
</table>
<p class="perdiem_table-note">All other California locations use the standard rate: $113 lodging and $68 M&amp;IE per day. Source: U.S. General Services Administration, FY2027. Data updated 27 Sep 2026.</p>
```
`City` (column 1) and `County` (column 2) show GSA's raw `city`/`county` text unchanged (never split,
even for a multi-county string). All GSA-sourced text is HTML-escaped. Show a range (`$232–$325`) when
lodging varies by month; a single value when it does not. The "Data updated" date is formatted
`27 Sep 2026` here (display only — `meta.json`'s `pulledAt` stays ISO). One row per `locations` entry
(the special-rate rows only), sorted A–Z by `city`.

Two variants:
- **Zero special-rate locations** (`locations` is empty): emit no table, only the note, reworded
  "All {displayName} locations use the standard rate: ...".
- **DC** (`standard: null`): its one location still renders as a normal table row, but the note reads
  "This rate applies to all of Washington D.C. Source: ..., Data updated ..." — no standard-rate
  sentence, since DC has none.

## The 49 states (abbreviation, slug, US Census region, featured)

Northeast: Connecticut CT connecticut · Maine ME maine · Massachusetts MA massachusetts (featured) ·
New Hampshire NH new-hampshire · New Jersey NJ new-jersey · New York NY new-york (featured) ·
Pennsylvania PA pennsylvania · Rhode Island RI rhode-island · Vermont VT vermont

Midwest: Illinois IL illinois (featured) · Indiana IN indiana · Iowa IA iowa · Kansas KS kansas ·
Michigan MI michigan · Minnesota MN minnesota · Missouri MO missouri · Nebraska NE nebraska ·
North Dakota ND north-dakota · Ohio OH ohio · South Dakota SD south-dakota · Wisconsin WI wisconsin

South: Alabama AL alabama · Arkansas AR arkansas · Delaware DE delaware ·
District of Columbia DC washington-dc (featured) · Florida FL florida (featured) ·
Georgia GA georgia (featured) · Kentucky KY kentucky · Louisiana LA louisiana · Maryland MD maryland ·
Mississippi MS mississippi · North Carolina NC north-carolina · Oklahoma OK oklahoma ·
South Carolina SC south-carolina · Tennessee TN tennessee · Texas TX texas (featured) ·
Virginia VA virginia · West Virginia WV west-virginia

West: Arizona AZ arizona · California CA california (featured) · Colorado CO colorado ·
Idaho ID idaho · Montana MT montana · Nevada NV nevada · New Mexico NM new-mexico · Oregon OR oregon ·
Utah UT utah · Washington WA washington (featured) · Wyoming WY wyoming

Display name for DC on pages: "Washington D.C.". GSA state code for it: `DC` *(verify)*.

## Calculator maths (Phase 4)

The full, locked spec is **`docs/phase-4-calculator.md`** (hook contract, calculation rules, behaviour,
export, analytics, golden tests). It wins over anything here. In short:

1. **Days** = inclusive calendar days; **nights** = days − 1, each night at its calendar month's lodging.
2. **Fiscal year per date** (1 Oct–30 Sep); each day and night uses its own FY's data file.
3. **M&IE** full rate per day, 75% on the first and last day (a same-day trip is one 75% day).
   **Incidentals** $5 per full day, $3.75 on first/last day; **meals** = M&IE − incidentals.
4. **Location** by `did` or `std`; DC has no `std`; a `did` missing in one FY falls back to that FY's
   `standard`.
5. Dates are parsed manually and computed in UTC — never local-time `Date` methods.
6. Dates outside the fiscal years in `meta.json` show an error, never a wrong number.
7. **Money keeps cents** (75% days give .25/.50/.75). Sum exact values, never round intermediate
   steps; display cents only when the amount isn't a whole dollar (`$788`, `$55.50`).

## Safety rules for the pull script

- Refuse to write anything if: any state does not have **exactly one** `City === "Standard Rate"` row
  — **except DC, which must have exactly zero** (and at least one location; DC with zero rows total
  is still a failure) — any lodging value is not a positive integer, any non-standard location has an
  empty/null `city` or `county`, or the total number of US locations returned by the pull is outside
  **±15%** of the previous committed pull's total (compare against the last commit; **skip this check
  on the first run**, when there is nothing to compare against). A state having zero special-rate
  locations is valid and must not be rejected. Two locations sharing a city name within a state is a
  **warning**, not a failure — log it and continue.
- All 49 state codes from `scripts/lib/states.js`, including DC, must appear in each fiscal year's
  response. Log (don't fail on) any state code present in the response but not in our list.
- The standard rate is one **national** value: outside DC, every state's standard lodging and M&IE
  must be identical within a fiscal year. DC is excluded from this check (it has no standard row).
- Fetch and validate **both fiscal years completely, in memory, before writing anything** — a failure
  on FY2027 must not leave FY2026 partially written either.
- Write to a temp directory first; move into `data/` only when all 98 state × FY results (from the
  2 HTTP responses) validate.
- Print a summary at the end: per state, `locations` count for each FY, and the standard rate found.
  Ashique spot-checks three states against gsa.gov before committing.
- Never delete the previous fiscal year's files. Old years stay in the repo.

## Annual refresh (Phase 8, for context)

A GitHub Action on 20 August pulls the coming fiscal year, validates with the rules above, commits
to a branch and opens a pull request. Nothing is merged automatically. After merge, a new exact
semver tag is cut (e.g. `v1.1.0`) and the Webflow page's script URL is updated to pin it. Rates go live on 1 October regardless of
when GSA publishes, because the calculator selects by travel date.

## Out of scope for this repo

Webflow page building, CMS collection creation, copywriting, HubSpot, GA4 configuration. The
Webflow API write of county tables into the CMS (Phase 6) will be a separate script with its own
backup / verify / rollback gate and is not started until Ashique asks for it.

// Phase 1: pull GSA per diem rates for both fiscal years, validate, write data/.
import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { states } from './lib/states.js';

const FISCAL_YEARS = [2026, 2027];
const PAUSE_MS = 300;
const RETRY_WAIT_MS = 5000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TMP_DIR = '.tmp-pull';

function loadApiKey() {
  let text;
  try {
    text = readFileSync('.env', 'utf8');
  } catch {
    console.error('Could not read .env — create it from .env.example and set GSA_API_KEY.');
    process.exit(1);
  }
  const line = text.split('\n').find((l) => l.trim().startsWith('GSA_API_KEY='));
  const key = line ? line.slice(line.indexOf('=') + 1).trim() : '';
  if (!key) {
    console.error('GSA_API_KEY is not set in .env.');
    process.exit(1);
  }
  return key;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchConusLodging(fy, apiKey) {
  const url = `https://api.gsa.gov/travel/perdiem/v2/rates/conus/lodging/${fy}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
    if (res.ok) {
      return JSON.parse(await res.text());
    }
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt === 1) {
      console.error(`FY${fy}: request failed with ${res.status}, retrying once after 5s...`);
      await sleep(RETRY_WAIT_MS);
      continue;
    }
    console.error(`FY${fy}: GSA request failed.`);
    console.error(`Status: ${res.status} ${res.statusText}`);
    console.error(`Body: ${body}`);
    process.exit(1);
  }
}

function normalizeRows(raw) {
  return Array.isArray(raw) ? raw : raw?.rates ?? [];
}

function toInt(value, context) {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    console.error(`Fail (${context}): expected an integer, got ${JSON.stringify(value)}.`);
    process.exit(1);
  }
  return n;
}

// Validates one fiscal year's raw rows and builds the per-state output objects.
// Fails loud (exit 1) on the first rule violation; never returns partial/invalid data.
function validateAndBuild(fy, rows) {
  const knownCodes = new Set(states.map((s) => s.abbreviation));
  const byState = new Map();
  const warnings = [];

  for (const row of rows) {
    const code = row.State;
    if (!knownCodes.has(code)) {
      console.log(`FY${fy}: note — response includes state code "${code}" not in our 49-state list (ignored).`);
      continue;
    }
    if (!byState.has(code)) byState.set(code, []);
    byState.get(code).push(row);
  }

  // Rule: all 49 states from scripts/lib/states.js, including DC, must be present.
  const missing = states.filter((s) => !byState.has(s.abbreviation));
  if (missing.length > 0) {
    console.error(`FY${fy}: missing state code(s) in GSA response: ${missing.map((s) => s.abbreviation).join(', ')}`);
    process.exit(1);
  }

  let nationalStandard = null;
  const stateFiles = new Map();

  for (const state of states) {
    const stateRows = byState.get(state.abbreviation);
    const isDC = state.abbreviation === 'DC';

    // Rule: exactly one "Standard Rate" row per state — except DC, which has none
    // (its whole area is one special-rate zone with nothing left over to be "standard").
    // DC still fails if it has zero rows at all, or more than one Standard Rate row.
    const standardRows = stateRows.filter((r) => r.City === 'Standard Rate');
    if (standardRows.length === 0 && !(isDC && stateRows.length > 0)) {
      console.error(`FY${fy} ${state.abbreviation}: expected exactly one "Standard Rate" row, found 0.`);
      process.exit(1);
    }
    if (standardRows.length > 1) {
      console.error(`FY${fy} ${state.abbreviation}: expected exactly one "Standard Rate" row, found ${standardRows.length}.`);
      process.exit(1);
    }

    let stdLodging = null;
    let stdMie = null;

    if (standardRows.length === 1) {
      const stdRow = standardRows[0];
      const stdLodgingValues = MONTHS.map((m) => toInt(stdRow[m], `FY${fy} ${state.abbreviation} standard lodging ${m}`));
      stdLodging = stdLodgingValues[0];
      if (!stdLodgingValues.every((v) => v === stdLodging)) {
        console.error(`FY${fy} ${state.abbreviation}: standard rate lodging is not flat across all 12 months: ${stdLodgingValues.join(',')}`);
        process.exit(1);
      }
      stdMie = toInt(stdRow.Meals, `FY${fy} ${state.abbreviation} standard M&IE`);
    }

    // Rule: the standard rate is one national value — identical across all 49 states.
    // DC is excluded: it has no standard row of its own to compare.
    if (!isDC) {
      if (nationalStandard === null) {
        nationalStandard = { lodging: stdLodging, mie: stdMie };
      } else if (nationalStandard.lodging !== stdLodging || nationalStandard.mie !== stdMie) {
        console.error(
          `FY${fy} ${state.abbreviation}: standard rate {lodging:${stdLodging}, mie:${stdMie}} differs from the ` +
            `national standard {lodging:${nationalStandard.lodging}, mie:${nationalStandard.mie}} seen in an earlier state.`
        );
        process.exit(1);
      }
    }

    // Non-standard locations: exactly 12 positive-integer lodging values, M&IE above 5.
    // For DC (no Standard Rate row), every row is a location.
    const locations = stateRows
      .filter((r) => r.City !== 'Standard Rate')
      .map((r) => {
        const lodging = MONTHS.map((m) => toInt(r[m], `FY${fy} ${state.abbreviation} DID ${r.DID} lodging ${m}`));
        if (lodging.some((v) => v <= 0)) {
          console.error(`FY${fy} ${state.abbreviation} DID ${r.DID}: lodging values must all be positive, got ${JSON.stringify(lodging)}.`);
          process.exit(1);
        }
        const mie = toInt(r.Meals, `FY${fy} ${state.abbreviation} DID ${r.DID} M&IE`);
        if (mie <= 5) {
          console.error(`FY${fy} ${state.abbreviation} DID ${r.DID}: M&IE must be above 5 (GSA's fixed incidental), got ${mie}.`);
          process.exit(1);
        }
        if (!r.City || !r.City.trim()) {
          console.error(`FY${fy} ${state.abbreviation} DID ${r.DID}: city is empty or null.`);
          process.exit(1);
        }
        if (!r.County || !r.County.trim()) {
          console.error(`FY${fy} ${state.abbreviation} DID ${r.DID}: county is empty or null.`);
          process.exit(1);
        }
        return { did: String(r.DID), county: r.County, city: r.City, mie, lodging };
      });

    locations.sort((a, b) => a.city.localeCompare(b.city));

    const cityCounts = new Map();
    for (const loc of locations) cityCounts.set(loc.city, (cityCounts.get(loc.city) ?? 0) + 1);
    for (const [city, count] of cityCounts) {
      if (count > 1) {
        const msg = `FY${fy} ${state.abbreviation}: ${count} locations share the city name "${city}".`;
        console.warn(`Warning — ${msg}`);
        warnings.push(msg);
      }
    }

    stateFiles.set(state.abbreviation, {
      state: state.abbreviation,
      fiscalYear: fy,
      standard: stdLodging === null ? null : { lodging: stdLodging, mie: stdMie },
      locations,
    });
  }

  let totalLocations = 0;
  for (const fileData of stateFiles.values()) totalLocations += fileData.locations.length;

  return { stateFiles, nationalStandard, totalLocations, warnings };
}

// Sum of `locations.length` across the currently-committed data/{fy}/*.json files, or
// null if there is nothing committed yet for this fiscal year (first run).
function previousTotalLocations(fy) {
  const dir = path.join('data', String(fy));
  if (!existsSync(dir)) return null;
  let total = 0;
  let anyFound = false;
  for (const state of states) {
    const file = path.join(dir, `${state.abbreviation}.json`);
    if (!existsSync(file)) continue;
    anyFound = true;
    const prev = JSON.parse(readFileSync(file, 'utf8'));
    total += prev.locations?.length ?? 0;
  }
  return anyFound ? total : null;
}

function fyDates(fy) {
  return { effective: `${fy - 1}-10-01`, expires: `${fy}-09-30` };
}

// Local calendar date (not UTC — toISOString() would be a day behind for anyone east of UTC
// in the hours just after their local midnight).
function todayLocal() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildMeta(fyOutputs) {
  const fiscalYears = {};
  for (const fy of FISCAL_YEARS) {
    fiscalYears[String(fy)] = { standard: fyOutputs[fy].nationalStandard, ...fyDates(fy) };
  }
  return {
    pulledAt: todayLocal(),
    fiscalYears,
    incidentals: 5,
    source: 'https://www.gsa.gov/travel/plan-book/per-diem-rates',
  };
}

function printSummary(summary) {
  console.log('\n=== Pull summary ===');
  for (const { fy, totalLocations, nationalStandard, perState, warnings } of summary) {
    console.log(`\nFY${fy}: standard rate = $${nationalStandard.lodging} lodging / $${nationalStandard.mie} M&IE (national)`);
    console.log(`Total special-rate locations: ${totalLocations}`);
    for (const { code, count } of perState) {
      console.log(`  ${code}: ${count} location(s)`);
    }
    if (warnings.length > 0) {
      console.log(`Warnings:`);
      for (const w of warnings) console.log(`  - ${w}`);
    } else {
      console.log('Warnings: none');
    }
  }
}

async function main() {
  const apiKey = loadApiKey();
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });

  const fyOutputs = {};
  const summary = [];

  // Phase A: fetch + validate BOTH fiscal years, entirely in memory. No file is written
  // (not even to the temp dir) until every fiscal year has passed every rule below.
  for (const fy of FISCAL_YEARS) {
    console.log(`Fetching FY${fy}...`);
    const raw = await fetchConusLodging(fy, apiKey);
    await sleep(PAUSE_MS);
    const rows = normalizeRows(raw);
    if (rows.length === 0) {
      console.error(`FY${fy}: GSA returned zero rows. Refusing to write.`);
      process.exit(1);
    }

    const { stateFiles, nationalStandard, totalLocations, warnings } = validateAndBuild(fy, rows);

    const prevTotal = previousTotalLocations(fy);
    if (prevTotal === null) {
      console.log(`FY${fy}: no previously committed data — skipping the ±15% total-locations check (first run).`);
    } else {
      const lower = prevTotal * 0.85;
      const upper = prevTotal * 1.15;
      if (totalLocations < lower || totalLocations > upper) {
        console.error(
          `FY${fy}: total locations ${totalLocations} is outside ±15% of the previously committed total ` +
            `${prevTotal} (allowed range ${Math.ceil(lower)}–${Math.floor(upper)}).`
        );
        process.exit(1);
      }
    }

    fyOutputs[fy] = { stateFiles, nationalStandard };
    summary.push({
      fy,
      totalLocations,
      nationalStandard,
      perState: [...stateFiles.entries()].map(([code, f]) => ({ code, count: f.locations.length })),
      warnings,
    });
  }

  // Phase B: every fiscal year validated — now write. Temp dir first, then an atomic-ish
  // move into data/. Old fiscal years already committed in data/ are untouched.
  for (const fy of FISCAL_YEARS) {
    const fyTmpDir = path.join(TMP_DIR, String(fy));
    mkdirSync(fyTmpDir, { recursive: true });
    for (const [code, fileData] of fyOutputs[fy].stateFiles) {
      writeFileSync(path.join(fyTmpDir, `${code}.json`), JSON.stringify(fileData, null, 2) + '\n');
    }
  }

  const meta = buildMeta(fyOutputs);
  writeFileSync(path.join(TMP_DIR, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

  for (const fy of FISCAL_YEARS) {
    const destDir = path.join('data', String(fy));
    mkdirSync(destDir, { recursive: true });
    for (const state of states) {
      renameSync(path.join(TMP_DIR, String(fy), `${state.abbreviation}.json`), path.join(destDir, `${state.abbreviation}.json`));
    }
  }
  renameSync(path.join(TMP_DIR, 'meta.json'), path.join('data', 'meta.json'));
  rmSync(TMP_DIR, { recursive: true, force: true });

  printSummary(summary);
}

main();

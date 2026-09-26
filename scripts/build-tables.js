// Phase 1: build cms/tables/{fy}/{ST}.html and cms/states.csv from data/.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { states } from './lib/states.js';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRange(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? `$${min}` : `$${min}–$${max}`;
}

// "2026-09-27" -> "27 Sep 2026", for display only. meta.json itself stays ISO.
function formatDisplayDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDate();
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${day} ${month} ${date.getUTCFullYear()}`;
}

// Builds one state's county-table HTML snippet: city first column, GSA's raw county
// text second column, then lodging/M&IE/total — special-rate locations only, plus a
// standard-rate note. All GSA-sourced text is HTML-escaped. If the state has no
// special-rate locations, only the note is emitted (no empty table).
function buildTableHtml(stateData, stateInfo, pulledAt) {
  const displayDate = escapeHtml(formatDisplayDate(pulledAt));
  const source = `Source: U.S. General Services Administration, FY${stateData.fiscalYear}. Data updated ${displayDate}.`;

  if (stateData.locations.length === 0) {
    const note =
      `All ${escapeHtml(stateInfo.displayName)} locations use the standard rate: ` +
      `$${stateData.standard.lodging} lodging and $${stateData.standard.mie} M&amp;IE per day. ${source}`;
    return `<p class="perdiem_table-note">${note}</p>\n`;
  }

  const rows = stateData.locations
    .map((loc) => {
      const city = escapeHtml(loc.city);
      const county = escapeHtml(loc.county);
      const lodging = formatRange(loc.lodging);
      const mie = `$${loc.mie}`;
      const total = formatRange(loc.lodging.map((v) => v + loc.mie));
      return `    <tr><td>${city}</td><td>${county}</td><td>${lodging}</td><td>${mie}</td><td>${total}</td></tr>`;
    })
    .join('\n');

  // No standard rate at all (DC): its one location's rate covers the whole state.
  // displayName can itself end in "." (e.g. "Washington D.C.") — avoid a doubled "..".
  const displayName = escapeHtml(stateInfo.displayName);
  const sentenceName = displayName.endsWith('.') ? displayName.slice(0, -1) : displayName;
  const note =
    stateData.standard === null
      ? `This rate applies to all of ${sentenceName}. ${source}`
      : `All other ${sentenceName} locations use the standard rate: ` +
        `$${stateData.standard.lodging} lodging and $${stateData.standard.mie} M&amp;IE per day. ${source}`;

  return `<table class="perdiem_table">
  <thead><tr><th>City</th><th>County</th><th>Lodging (per night)</th><th>M&amp;IE (per day)</th><th>Total</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
<p class="perdiem_table-note">${note}</p>
`;
}

function csvField(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// cms/states.csv: Name,Slug,Abbreviation,Region,Featured,County table HTML — every field
// quoted, embedded quotes doubled (standard CSV), line breaks inside the HTML kept as-is.
function buildStatesCsv(tableHtmlByState) {
  const header = ['Name', 'Slug', 'Abbreviation', 'Region', 'Featured', 'County table HTML'].map(csvField).join(',');
  const rows = states.map((s) =>
    [s.displayName, s.slug, s.abbreviation, s.region, s.featured ? 'true' : 'false', tableHtmlByState.get(s.abbreviation)]
      .map(csvField)
      .join(',')
  );
  return [header, ...rows].join('\n') + '\n';
}

function main() {
  if (!existsSync('data/meta.json')) {
    console.error('data/meta.json not found — run `npm run pull` first.');
    process.exit(1);
  }
  const meta = JSON.parse(readFileSync('data/meta.json', 'utf8'));
  const fiscalYears = Object.keys(meta.fiscalYears).map(Number);
  if (fiscalYears.length === 0) {
    console.error('data/meta.json has no fiscalYears entries.');
    process.exit(1);
  }

  const CSV_FY = 2027;
  if (!fiscalYears.includes(CSV_FY)) {
    console.error(`data/meta.json has no FY${CSV_FY} entry — cms/states.csv needs it for the County table HTML column.`);
    process.exit(1);
  }
  const csvTableHtml = new Map();

  for (const fy of fiscalYears) {
    const fyDir = path.join('data', String(fy));
    if (!existsSync(fyDir)) {
      console.error(`data/${fy} is missing though meta.json lists it.`);
      process.exit(1);
    }
    const outDir = path.join('cms', 'tables', String(fy));
    mkdirSync(outDir, { recursive: true });
    for (const state of states) {
      const file = path.join(fyDir, `${state.abbreviation}.json`);
      if (!existsSync(file)) {
        console.error(`Missing ${file}.`);
        process.exit(1);
      }
      const stateData = JSON.parse(readFileSync(file, 'utf8'));
      const html = buildTableHtml(stateData, state, meta.pulledAt);
      writeFileSync(path.join(outDir, `${state.abbreviation}.html`), html);
      if (fy === CSV_FY) csvTableHtml.set(state.abbreviation, html);
    }
  }

  mkdirSync('cms', { recursive: true });
  writeFileSync(path.join('cms', 'states.csv'), buildStatesCsv(csvTableHtml));

  console.log(`Wrote cms/states.csv (with FY${CSV_FY} table HTML) and cms/tables/{fy}/{ST}.html for fiscal year(s): ${fiscalYears.join(', ')}.`);
}

main();

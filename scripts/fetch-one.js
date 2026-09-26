// Phase 1, step 3: one-off fetch to inspect the real GSA response shape.
// Fetches DE/FY2027 (state rates) and the FY2027 CONUS lodging list, saves both raw.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

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

async function fetchJson(url, apiKey) {
  const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
  const body = await res.text();
  if (!res.ok) {
    console.error(`Request failed: ${res.status} ${res.statusText}`);
    console.error(`URL: ${url}`);
    console.error(`Body: ${body}`);
    process.exit(1);
  }
  return JSON.parse(body);
}

const apiKey = loadApiKey();
mkdirSync('fixtures', { recursive: true });

// 1. State rates: Delaware, FY2027
const stateUrl = 'https://api.gsa.gov/travel/perdiem/v2/rates/state/DE/year/2027';
const stateData = await fetchJson(stateUrl, apiKey);
writeFileSync('fixtures/raw-DE-2027.json', JSON.stringify(stateData, null, 2));

console.log('=== fixtures/raw-DE-2027.json ===');
console.log('Top-level keys:', Object.keys(stateData));

let firstLocation = null;
if (Array.isArray(stateData.rates) && stateData.rates.length > 0) {
  const firstRateEntry = stateData.rates[0];
  if (Array.isArray(firstRateEntry.rate) && firstRateEntry.rate.length > 0) {
    firstLocation = firstRateEntry.rate[0];
  }
}
console.log('One complete location entry:');
console.log(JSON.stringify(firstLocation, null, 2));

// 2. CONUS lodging list, FY2027
const conusUrl = 'https://api.gsa.gov/travel/perdiem/v2/rates/conus/lodging/2027';
const conusData = await fetchJson(conusUrl, apiKey);
writeFileSync('fixtures/raw-conus-lodging-2027.json', JSON.stringify(conusData, null, 2));

console.log('\n=== fixtures/raw-conus-lodging-2027.json ===');
const conusEntries = Array.isArray(conusData) ? conusData : conusData.rates ?? [];
console.log('Total number of entries:', conusEntries.length);
const deEntries = conusEntries.filter((e) => e.State === 'DE');
console.log('Entries with State = "DE":', deEntries.length);
console.log('One complete entry:');
console.log(JSON.stringify(conusEntries[0], null, 2));

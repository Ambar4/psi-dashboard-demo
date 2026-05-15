#!/usr/bin/env node
// generate-demo-data.js
// Demo-only: produces illustrative data for sources that don't have real APIs
// behind them (TinaCMS edits, Optimizely experiments, GA4 per-URL metrics).
// Reads static templates from clients/<client>/demo-data/ and writes per-snapshot
// output that build-snapshot folds into the snapshot like any real source.
//
// Usage:
//   node scripts/generate-demo-data.js <client> [snapshot-id]
//
// Gated on config.demoMode === true. No-ops for non-demo clients so the same
// workflow can run for LHC matrix jobs without generating fake data.

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.dirname(SCRIPT_DIR);

const CLIENT = process.argv[2];
const SNAPSHOT_ID = process.argv[3] || new Date().toISOString().slice(0, 10);

if (!CLIENT) {
  console.error('Usage: node generate-demo-data.js <client> [snapshot-id]');
  process.exit(2);
}

const CLIENT_DIR = path.join(ROOT_DIR, 'clients', CLIENT);
const CONFIG_PATH = path.join(CLIENT_DIR, 'config.json');
const INDEX_PATH = path.join(CLIENT_DIR, 'snapshots', 'index.json');
const DEMO_DIR = path.join(CLIENT_DIR, 'demo-data');
const RAW_DIR = path.join(CLIENT_DIR, 'psi-raw', SNAPSHOT_ID);

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Config not found: ${CONFIG_PATH}`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

if (!cfg.demoMode) {
  console.log(`Client ${CLIENT} is not in demoMode. Skipping demo-data generation.`);
  process.exit(0);
}

if (!fs.existsSync(DEMO_DIR)) {
  console.log(`No demo-data directory at ${DEMO_DIR}. Nothing to generate.`);
  process.exit(0);
}

ensureDir(RAW_DIR);

const BASE_URL = (cfg.baseUrl || '').replace(/\/$/, '');

// --- Time window ----------------------------------------------------------

function computeWindow() {
  let prevDate = '';
  if (fs.existsSync(INDEX_PATH)) {
    const idx = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    const earlier = idx
      .filter(s => s.id < SNAPSHOT_ID)
      .sort((a, b) => b.id.localeCompare(a.id));
    if (earlier.length) prevDate = earlier[0].id;
  }
  if (!prevDate) {
    const [y, m, d] = SNAPSHOT_ID.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 7);
    prevDate = dt.toISOString().slice(0, 10);
  }
  return {
    since: `${prevDate}T00:00:01Z`,
    until: `${SNAPSHOT_ID}T23:59:59Z`,
  };
}

const { since: SINCE, until: UNTIL } = computeWindow();

console.log(`Client:    ${CLIENT}  (demoMode)`);
console.log(`Window:    ${SINCE}  ->  ${UNTIL}`);

// --- Deterministic PRNG ---------------------------------------------------

// djb2-derived hash -> [0, 1). Same seed always returns the same value, so
// demo data is stable across re-deploys for the same snapshot date.
function seededRandom(seed) {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h) + seed.charCodeAt(i);
    h = h | 0;
  }
  return (Math.abs(h) % 1000000) / 1000000;
}

function seededFloat(seed, min, max) {
  return min + seededRandom(seed) * (max - min);
}

// Pick a timestamp within (SINCE, UNTIL] keyed by a seed string.
function dateInWindow(seed) {
  const tSince = Date.parse(SINCE);
  const tUntil = Date.parse(UNTIL);
  const span = Math.max(1, tUntil - tSince);
  const t = tSince + Math.floor(seededRandom(seed) * span);
  return new Date(t).toISOString();
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`Failed to parse ${p}: ${e.message}`); return null; }
}

// --- TinaCMS items --------------------------------------------------------

function generateTinaItems() {
  const src = readJsonIfExists(path.join(DEMO_DIR, 'tina-items.json'));
  if (!src || !Array.isArray(src.items)) return [];
  return src.items.map(item => ({
    type: item.type || 'tina-page',
    title: item.title,
    date: dateInWindow(`${SNAPSHOT_ID}:tina:${item.title}`),
    author: item.author,
    url: BASE_URL + (item.urlPath || '/'),
    status: 'publish',
    // Activity impact scoring (optional). Passed through from the static
    // template so the dashboard can render Speed / Traffic / Conversion
    // likelihood per item.
    scores: item.scores || null,
    drivers: Array.isArray(item.drivers) ? item.drivers : [],
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// --- Optimizely experiments -----------------------------------------------

function fakeOptimizelyUrl(title) {
  // Realistic-looking but illustrative. The disclaimer covers expectations.
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '');
  return `https://app.optimizely.com/v2/projects/9876543/experiments/${slug}`;
}

function generateOptimizelyItems() {
  const src = readJsonIfExists(path.join(DEMO_DIR, 'optimizely-experiments.json'));
  if (!src || !Array.isArray(src.items)) return [];
  return src.items.map(item => ({
    type: 'experiment',
    title: item.title,
    date: dateInWindow(`${SNAPSHOT_ID}:opt:${item.title}`),
    author: item.author,
    url: fakeOptimizelyUrl(item.title),
    hypothesis: item.hypothesis,
    status: item.status,
    reason: item.reason || 'updated',
    scores: item.scores || null,
    drivers: Array.isArray(item.drivers) ? item.drivers : [],
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// --- GA4 per-URL metrics --------------------------------------------------

function generateGa4() {
  const src = readJsonIfExists(path.join(DEMO_DIR, 'ga4-baseline.json'));
  if (!src || !src.urls) return { urls: {} };
  const out = {};
  for (const [url, baseline] of Object.entries(src.urls)) {
    // Baseline can be device-split ({mobile: {...}, desktop: {...}}) or flat
    // ({views, users, ...}). Detect by looking for the mobile key.
    const deviceSplit = baseline && baseline.mobile && baseline.desktop;
    if (deviceSplit) {
      out[url] = {};
      for (const device of ['mobile', 'desktop']) {
        const dev = baseline[device];
        const drift = m => seededFloat(`${SNAPSHOT_ID}:${url}:${device}:${m}`, -0.15, 0.15);
        out[url][device] = {
          views:        Math.max(0, Math.round(dev.views        * (1 + drift('views')))),
          users:        Math.max(0, Math.round(dev.users        * (1 + drift('users')))),
          engagementMs: Math.max(0, Math.round(dev.engagementMs * (1 + drift('engage')))),
          keyEvents:    Math.max(0, Math.round(dev.keyEvents    * (1 + drift('keyEvents')))),
        };
      }
    } else {
      // Legacy flat shape: keep emitting the same shape so build-snapshot stays
      // backward-compatible.
      const drift = m => seededFloat(`${SNAPSHOT_ID}:${url}:${m}`, -0.15, 0.15);
      out[url] = {
        views:        Math.max(0, Math.round(baseline.views        * (1 + drift('views')))),
        users:        Math.max(0, Math.round(baseline.users        * (1 + drift('users')))),
        engagementMs: Math.max(0, Math.round(baseline.engagementMs * (1 + drift('engage')))),
        keyEvents:    Math.max(0, Math.round(baseline.keyEvents    * (1 + drift('keyEvents')))),
      };
    }
  }
  return { urls: out };
}

// --- Main -----------------------------------------------------------------

const outputs = {
  'tinacms.json':    cfg.tinacms   && cfg.tinacms.enabled   !== false ? { items: generateTinaItems() }       : null,
  'optimizely.json': cfg.optimizely && cfg.optimizely.enabled !== false ? { items: generateOptimizelyItems() } : null,
  'ga4.json':        cfg.ga4       && cfg.ga4.enabled       !== false ? generateGa4()                        : null,
};

for (const [filename, payload] of Object.entries(outputs)) {
  if (payload == null) {
    console.log(`  ${filename.padEnd(18)} skipped (source disabled)`);
    continue;
  }
  const outPath = path.join(RAW_DIR, filename);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
  const count = Array.isArray(payload.items) ? payload.items.length
              : (payload.urls ? Object.keys(payload.urls).length : 0);
  console.log(`  ${filename.padEnd(18)} ${count} item(s) -> ${outPath}`);
}

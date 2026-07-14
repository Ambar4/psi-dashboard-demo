#!/usr/bin/env node
// fetch-gb-changes.js
// Pulls GrowthBook experiments touched in the snapshot window from the cloud API.
// Writes results to clients/<client>/psi-raw/<snapshot-id>/growthbook.json so
// build-snapshot.js can fold them into the snapshot.
//
// Usage:
//   node scripts/fetch-gb-changes.js <client> [snapshot-id]
//
// Auth: reads the API key from env var <CLIENT_UPPER>_GROWTHBOOK_API_KEY
// (e.g. ACME_GROWTHBOOK_API_KEY for a client with id "acme").
//
// Skips silently (writes an empty items file) if:
//   - the client config has no `growthbook` block, or
//   - `growthbook.enabled` is false, or
//   - the env var holding the API key is unset.

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.dirname(SCRIPT_DIR);

const CLIENT = process.argv[2];
const SNAPSHOT_ID = process.argv[3] || new Date().toISOString().slice(0, 10);

if (!CLIENT) {
  console.error('Usage: node fetch-gb-changes.js <client> [snapshot-id]');
  process.exit(2);
}

const CLIENT_DIR = path.join(ROOT_DIR, 'clients', CLIENT);
const CONFIG_PATH = path.join(CLIENT_DIR, 'config.json');
const INDEX_PATH = path.join(CLIENT_DIR, 'snapshots', 'index.json');
const RAW_DIR = path.join(CLIENT_DIR, 'psi-raw', SNAPSHOT_ID);
const OUT_FILE = path.join(RAW_DIR, 'growthbook.json');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Config not found: ${CONFIG_PATH}`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const gbCfg = cfg.growthbook;
if (!gbCfg || gbCfg.enabled === false) {
  console.log(`No growthbook config or disabled for ${CLIENT}. Skipping GB fetch.`);
  ensureDir(RAW_DIR);
  fs.writeFileSync(OUT_FILE, JSON.stringify({ items: [] }, null, 2) + '\n');
  process.exit(0);
}

const envVar = `${CLIENT.toUpperCase()}_GROWTHBOOK_API_KEY`;
const API_KEY = process.env[envVar];
if (!API_KEY) {
  console.log(`${envVar} not set. Skipping GB fetch.`);
  ensureDir(RAW_DIR);
  fs.writeFileSync(OUT_FILE, JSON.stringify({ items: [] }, null, 2) + '\n');
  process.exit(0);
}

const API_BASE = (gbCfg.apiBase || 'https://api.growthbook.io').replace(/\/$/, '');
const PROJECT_ID = gbCfg.projectId || '';  // empty = all projects

// --- Time window ----------------------------------------------------------

// Mirrors fetch-wp-changes.js: window is (prevSnapshotDate 23:59:59, snapshotDate 23:59:59].
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
    since: `${prevDate}T23:59:59Z`,
    until: `${SNAPSHOT_ID}T23:59:59Z`,
    prevDate,
  };
}

const { since: SINCE, until: UNTIL } = computeWindow();

console.log(`Client:    ${CLIENT}`);
console.log(`GB API:    ${API_BASE}`);
if (PROJECT_ID) console.log(`Project:   ${PROJECT_ID}`);
console.log(`Window:    ${SINCE}  ->  ${UNTIL}`);

// --- Fetch helpers --------------------------------------------------------

async function gbGet(pathAndQuery) {
  const url = `${API_BASE}/api/v1/${pathAndQuery}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Accept': 'application/json',
      'User-Agent': 'psi-dashboard/1.0',
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const snippet = body.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`GET ${url} -> HTTP ${resp.status}. Body: ${snippet}`);
  }
  return resp.json();
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function fail(message) {
  console.error(message);
  ensureDir(RAW_DIR);
  fs.writeFileSync(OUT_FILE, JSON.stringify({ error: message, items: [] }, null, 2) + '\n');
  process.exit(0);  // surface error via JSON, don't break the workflow
}

// Find the most relevant "activity date" for an experiment within the window.
// Priority order:
//   1. phases[N].dateStarted in window  (test went live)
//   2. dateUpdated in window            (configuration touched)
//   3. dateCreated in window            (new draft)
// Returns the activity date as ISO string, plus a "reason" tag describing why.
function activityInWindow(exp, since, until) {
  const inRange = iso => iso && iso > since && iso <= until;
  // Most recent phase's dateStarted (or dateEnded) inside the window.
  const phases = Array.isArray(exp.phases) ? exp.phases : [];
  for (let i = phases.length - 1; i >= 0; i--) {
    const ph = phases[i] || {};
    if (inRange(ph.dateStarted)) return { date: ph.dateStarted, reason: 'started' };
    if (inRange(ph.dateEnded))   return { date: ph.dateEnded,   reason: 'stopped' };
  }
  if (inRange(exp.dateUpdated)) return { date: exp.dateUpdated, reason: 'updated' };
  if (inRange(exp.dateCreated)) return { date: exp.dateCreated, reason: 'created' };
  return null;
}

function normalizeItem(exp, activity) {
  const publicURL = exp.publicURL
    || `https://app.growthbook.io/experiment/${exp.id}`;
  return {
    type: 'experiment',
    title: exp.name || `(unnamed experiment ${exp.id})`,
    date: activity.date,
    author: exp.owner || '',
    url: publicURL,
    hypothesis: exp.hypothesis || '',
    description: exp.description || '',
    status: exp.status || 'unknown',
    reason: activity.reason,  // 'started' | 'stopped' | 'updated' | 'created'
    id: exp.id,
    project: exp.project || '',
  };
}

async function fetchAllExperiments() {
  // GB's experiments endpoint paginates with limit/offset, default limit 10.
  // We bump to 100 (the API cap) and follow hasMore until we've drained the page set.
  const all = [];
  let offset = 0;
  const limit = 100;
  for (let i = 0; i < 20; i++) {  // hard cap at 2,000 experiments to avoid runaway loop
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (PROJECT_ID) q.set('projectId', PROJECT_ID);
    const page = await gbGet(`experiments?${q.toString()}`);
    const items = page.experiments || [];
    all.push(...items);
    if (!page.hasMore || items.length === 0) break;
    offset = page.nextOffset != null ? page.nextOffset : offset + limit;
  }
  return all;
}

// --- Main -----------------------------------------------------------------

(async function main() {
  ensureDir(RAW_DIR);

  let experiments;
  try {
    experiments = await fetchAllExperiments();
    console.log(`  Fetched: ${experiments.length} experiment(s) total`);
  } catch (e) {
    return fail(`GB fetch failed: ${e.message}`);
  }

  const items = experiments
    .map(exp => {
      const activity = activityInWindow(exp, SINCE, UNTIL);
      return activity ? normalizeItem(exp, activity) : null;
    })
    .filter(Boolean)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // Tally by reason for visibility.
  const tally = items.reduce((acc, it) => {
    acc[it.reason] = (acc[it.reason] || 0) + 1;
    return acc;
  }, {});
  console.log(`  In window: ${items.length} (${Object.entries(tally).map(([k,v]) => `${k}:${v}`).join(', ') || 'none'})`);

  fs.writeFileSync(OUT_FILE, JSON.stringify({ items }, null, 2) + '\n');
  console.log(`Wrote ${items.length} GB change(s) to ${OUT_FILE}`);
})().catch(e => fail(`Unexpected error: ${e.stack || e.message}`));

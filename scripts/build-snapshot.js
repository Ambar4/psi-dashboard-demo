#!/usr/bin/env node
// build-snapshot.js
// Reads raw PageSpeed Insights JSON from clients/<client>/psi-raw/<snapshot-id>/
// and emits a compact clients/<client>/snapshots/<snapshot-id>.json plus updates
// the per-client snapshots/index.json.
//
// Usage:
//   node scripts/build-snapshot.js <client> [snapshot-id]
//
// URLs and their order come from clients/<client>/config.json.

const fs = require('fs');
const path = require('path');
const { scoreItem } = require('./score-activity');

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.dirname(SCRIPT_DIR);

const CLIENT = process.argv[2];
const SNAPSHOT_ID = process.argv[3] || new Date().toISOString().slice(0, 10);

if (!CLIENT) {
  console.error('Usage: node build-snapshot.js <client> [snapshot-id]');
  process.exit(2);
}

const CLIENT_DIR = path.join(ROOT_DIR, 'clients', CLIENT);
const CONFIG_PATH = path.join(CLIENT_DIR, 'config.json');
const RAW_DIR = path.join(CLIENT_DIR, 'psi-raw', SNAPSHOT_ID);
const SNAPSHOTS_DIR = path.join(CLIENT_DIR, 'snapshots');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Config not found: ${CONFIG_PATH}`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const URLS = config.urls;
if (!Array.isArray(URLS) || URLS.length === 0) {
  console.error(`No urls[] in ${CONFIG_PATH}`);
  process.exit(1);
}

// Map dashboard metric keys → PSI audit IDs.
const METRIC_AUDITS = {
  lcp: 'largest-contentful-paint',
  fcp: 'first-contentful-paint',
  cls: 'cumulative-layout-shift',
  tbt: 'total-blocking-time',
  si: 'speed-index',
  ttfb: 'server-response-time',
};

// Pull the top N performance opportunities from a Lighthouse audits dict.
// PSI marks formal opportunities with details.type === 'opportunity' and
// attaches estimated savings (overallSavingsMs / overallSavingsBytes).
// Returned items are sorted descending by ms savings, then bytes.
function extractInsights(audits, limit = 3) {
  const opps = [];
  for (const [id, a] of Object.entries(audits || {})) {
    const details = a && a.details;
    if (!details || details.type !== 'opportunity') continue;
    if (a.score == null || a.score >= 1) continue;
    const ms = details.overallSavingsMs || 0;
    const bytes = details.overallSavingsBytes || 0;
    if (ms === 0 && bytes === 0) continue;
    opps.push({
      id,
      title: a.title || id,
      savingsMs: ms || null,
      savingsBytes: bytes || null,
      displayValue: a.displayValue || null,
    });
  }
  opps.sort((a, b) => (b.savingsMs || 0) - (a.savingsMs || 0)
    || (b.savingsBytes || 0) - (a.savingsBytes || 0));
  return opps.slice(0, limit);
}

// Returns a row with all-null scores/metrics. Used when PSI failed for a URL
// (timeout, Lighthouse error, etc.) so build-snapshot.js doesn't crash on the
// malformed/empty raw file. The dashboard renders nulls as dashes.
function nullRow(url, reason) {
  console.warn(`WARN: ${url} → ${reason}. Inserting null row.`);
  return {
    url,
    fetchTime: null,
    scores: { performance: null, accessibility: null, bestPractices: null, seo: null },
    metrics: {
      lcp:  { display: '-', score: null },
      fcp:  { display: '-', score: null },
      cls:  { display: '-', score: null },
      tbt:  { display: '-', score: null },
      si:   { display: '-', score: null },
      ttfb: { display: '-', score: null },
    },
    insights: [],
  };
}

function extractRow(rawPath, url) {
  if (!fs.existsSync(rawPath)) {
    return nullRow(url, `missing raw file ${rawPath}`);
  }
  let raw;
  try {
    const text = fs.readFileSync(rawPath, 'utf8');
    if (!text.trim()) {
      return nullRow(url, 'raw PSI file is empty (likely API timeout)');
    }
    raw = JSON.parse(text);
  } catch (e) {
    return nullRow(url, `could not parse PSI response: ${e.message}`);
  }
  const lh = raw.lighthouseResult;
  if (!lh) {
    const apiErr = raw && raw.error && raw.error.message;
    return nullRow(url, apiErr ? `PSI API error: ${apiErr}` : 'no lighthouseResult in PSI response');
  }

  const cats = lh.categories;
  const round = v => (v == null ? null : Math.round(v * 100));
  const scores = {
    performance: round(cats.performance && cats.performance.score),
    accessibility: round(cats.accessibility && cats.accessibility.score),
    bestPractices: round(cats['best-practices'] && cats['best-practices'].score),
    seo: round(cats.seo && cats.seo.score),
  };

  const metrics = {};
  for (const [key, auditId] of Object.entries(METRIC_AUDITS)) {
    const a = lh.audits[auditId] || {};
    metrics[key] = {
      display: a.displayValue || '-',
      score: a.score == null ? null : a.score,
    };
  }

  const insights = extractInsights(lh.audits);

  return { url, fetchTime: lh.fetchTime || null, scores, metrics, insights };
}

function buildStrategyArray(strategy) {
  return URLS.map((url, i) => {
    const rawPath = path.join(RAW_DIR, `url-${i}-${strategy}.json`);
    return extractRow(rawPath, url);
  });
}

// Read changes.json (written by fetch-changes.sh) if it exists.
// Returns the items array, or [] if missing/errored.
function readChanges() {
  const p = path.join(RAW_DIR, 'changes.json');
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data.error) {
      console.error(`changes.json reports error: ${data.error}`);
    }
    return Array.isArray(data.items) ? data.items : [];
  } catch (e) {
    console.error(`Failed to parse changes.json: ${e.message}`);
    return [];
  }
}

// Read wordpress.json (written by fetch-wp-changes.js) if it exists.
// Returns the items array, or [] if missing/errored.
function readWordPressChanges() {
  return readChangesFile('wordpress.json');
}

// Read growthbook.json (written by fetch-gb-changes.js) if it exists.
function readGrowthBookChanges() {
  return readChangesFile('growthbook.json');
}

// Demo-only sources (written by generate-demo-data.js):
function readTinacmsChanges()    { return readChangesFile('tinacms.json'); }
function readOptimizelyChanges() { return readChangesFile('optimizely.json'); }

// GA4 has a different shape: { urls: { <url>: { views, users, ... } } }.
// Returns the urls object, or {} if missing/errored.
function readGa4Metrics() {
  const p = path.join(RAW_DIR, 'ga4.json');
  if (!fs.existsSync(p)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data.error) console.error(`ga4.json reports error: ${data.error}`);
    return (data && data.urls) || {};
  } catch (e) {
    console.error(`Failed to parse ga4.json: ${e.message}`);
    return {};
  }
}

function readChangesFile(filename) {
  const p = path.join(RAW_DIR, filename);
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data.error) {
      console.error(`${filename} reports error: ${data.error}`);
    }
    return Array.isArray(data.items) ? data.items : [];
  } catch (e) {
    console.error(`Failed to parse ${filename}: ${e.message}`);
    return [];
  }
}

function updateIndex(snapshotId, capturedAt) {
  const indexPath = path.join(SNAPSHOTS_DIR, 'index.json');
  let idx = [];
  if (fs.existsSync(indexPath)) {
    idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  }
  idx = idx.filter(s => s.id !== snapshotId);
  idx.push({ id: snapshotId, capturedAt });
  idx.sort((a, b) => b.id.localeCompare(a.id));
  fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2) + '\n');
  return idx;
}

(function main() {
  if (!fs.existsSync(RAW_DIR)) {
    console.error(`Raw PSI folder not found: ${RAW_DIR}`);
    console.error(`Run \`./scripts/run-psi.sh ${CLIENT} ${SNAPSHOT_ID}\` first.`);
    process.exit(1);
  }
  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }

  console.log(`Client:    ${CLIENT}`);
  console.log(`Snapshot:  ${SNAPSHOT_ID}`);
  console.log(`Reading from ${RAW_DIR}`);

  const mobile = buildStrategyArray('mobile');
  const desktop = buildStrategyArray('desktop');

  const allTimes = [...mobile, ...desktop]
    .map(r => r.fetchTime)
    .filter(Boolean)
    .sort();
  const capturedAt = allTimes[0] || new Date().toISOString();

  // Pre-authored scores (from demo static data) win over inference. For
  // real-source items (from GitHub/WP/GB fetchers) scores are absent, so
  // the inference fills them in.
  const maybeScore = (item) => {
    if (!item || (item.scores && item.scores.speed)) return item;
    const result = scoreItem(item);
    return { ...item, scores: result.scores, drivers: result.drivers };
  };

  const commits = readChanges().map(maybeScore);
  const wordpress = readWordPressChanges().map(maybeScore);
  const growthbook = readGrowthBookChanges().map(maybeScore);
  const tinacms = readTinacmsChanges().map(maybeScore);
  const optimizely = readOptimizelyChanges().map(maybeScore);
  const ga4 = readGa4Metrics();
  const snapshot = {
    id: SNAPSHOT_ID,
    capturedAt,
    commits,
    wordpress,
    growthbook,
    tinacms,
    optimizely,
    ga4,
    mobile,
    desktop,
  };
  const outPath = path.join(SNAPSHOTS_DIR, `${SNAPSHOT_ID}.json`);
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`Wrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);

  const idx = updateIndex(SNAPSHOT_ID, capturedAt);
  console.log(`Updated snapshots/index.json. ${idx.length} snapshot${idx.length === 1 ? '' : 's'} for ${CLIENT}:`);
  for (const s of idx) console.log(`  ${s.id}  (${s.capturedAt})`);

  const avg = (arr, k) => Math.round(arr.reduce((s, r) => s + (r.scores[k] ?? 0), 0) / arr.length);
  console.log('\nSummary:');
  console.log(`  Mobile  perf=${avg(mobile, 'performance')}  a11y=${avg(mobile, 'accessibility')}  bp=${avg(mobile, 'bestPractices')}  seo=${avg(mobile, 'seo')}`);
  console.log(`  Desktop perf=${avg(desktop, 'performance')}  a11y=${avg(desktop, 'accessibility')}  bp=${avg(desktop, 'bestPractices')}  seo=${avg(desktop, 'seo')}`);
  console.log(`  Commits in window:  ${commits.length}`);
  console.log(`  WP changes:         ${wordpress.length}`);
  console.log(`  GB experiments:     ${growthbook.length}`);
  console.log(`  TinaCMS edits:      ${tinacms.length}`);
  console.log(`  Optimizely:         ${optimizely.length}`);
  console.log(`  GA4 URLs tracked:   ${Object.keys(ga4).length}`);
})();

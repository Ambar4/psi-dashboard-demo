#!/usr/bin/env node
// fetch-ga4.js
// Pulls per-URL GA4 metrics (Views, Active Users, avg Engagement, Key Events)
// for the snapshot window, split by deviceCategory (mobile / desktop). Writes
// clients/<client>/psi-raw/<snapshot-id>/ga4.json in the shape build-snapshot
// already understands:
//
//   {
//     "urls": {
//       "https://...": {
//         "mobile":  { "views": N, "users": N, "engagementMs": N, "keyEvents": N },
//         "desktop": { ... }
//       },
//       ...
//     }
//   }
//
// Usage:
//   node scripts/fetch-ga4.js <client> [snapshot-id]
//
// Auth: reads the service account JSON key from env var
// <CLIENT_UPPER>_GA4_SERVICE_ACCOUNT_KEY (e.g. ACME_GA4_SERVICE_ACCOUNT_KEY
// for a client with id "acme"). The value is the entire JSON file contents,
// dumped from GCP IAM -> Service Accounts -> Keys.
//
// Skips cleanly (writes {urls:{}} and exits 0) if:
//   - config has no `ga4` block, or
//   - `ga4.enabled` is false, or
//   - `ga4.propertyId` is missing, or
//   - the env var holding the key is unset.
// Same pattern as fetch-wp-changes.js / fetch-gb-changes.js so the workflow
// can run for clients that don't have GA4 wired up without failing.

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.dirname(SCRIPT_DIR);

const CLIENT = process.argv[2];
const SNAPSHOT_ID = process.argv[3] || new Date().toISOString().slice(0, 10);

if (!CLIENT) {
  console.error('Usage: node fetch-ga4.js <client> [snapshot-id]');
  process.exit(2);
}

const CLIENT_DIR = path.join(ROOT_DIR, 'clients', CLIENT);
const CONFIG_PATH = path.join(CLIENT_DIR, 'config.json');
const INDEX_PATH = path.join(CLIENT_DIR, 'snapshots', 'index.json');
const RAW_DIR = path.join(CLIENT_DIR, 'psi-raw', SNAPSHOT_ID);
const OUT_FILE = path.join(RAW_DIR, 'ga4.json');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeAndExit(payload, code = 0) {
  ensureDir(RAW_DIR);
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + '\n');
  process.exit(code);
}

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Config not found: ${CONFIG_PATH}`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const ga4Cfg = cfg.ga4;
if (!ga4Cfg || ga4Cfg.enabled === false) {
  console.log(`No ga4 config or disabled for ${CLIENT}. Skipping GA4 fetch.`);
  writeAndExit({ urls: {} });
}
if (!ga4Cfg.propertyId) {
  console.log(`ga4.propertyId missing for ${CLIENT}. Skipping GA4 fetch.`);
  writeAndExit({ urls: {} });
}

const envVar = `${CLIENT.toUpperCase()}_GA4_SERVICE_ACCOUNT_KEY`;
const RAW_KEY = process.env[envVar];
if (!RAW_KEY) {
  console.log(`${envVar} not set. Skipping GA4 fetch.`);
  writeAndExit({ urls: {} });
}

let credentials;
try {
  credentials = JSON.parse(RAW_KEY);
} catch (e) {
  console.error(`${envVar} is not valid JSON: ${e.message}`);
  writeAndExit({ error: `${envVar} is not valid JSON`, urls: {} });
}

// --- Time window ----------------------------------------------------------

// Same logic as the other fetchers: window is (prevSnapshotDate, snapshotDate].
// Falls back to 7 days before snapshot if no prior snapshot in index.
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
  return { startDate: prevDate, endDate: SNAPSHOT_ID };
}

const { startDate, endDate } = computeWindow();

console.log(`Client:    ${CLIENT}`);
console.log(`Property:  properties/${ga4Cfg.propertyId}`);
console.log(`Window:    ${startDate}  ->  ${endDate}`);

// --- URL -> pagePath map --------------------------------------------------

// GA4's pagePath dimension returns the path component only (no host). Build
// a map from path -> full URL so the output can be keyed by the same full
// URLs the dashboard already shows in cards.
//
// Trailing-slash normalization: GA4 stores whatever path users actually
// visited, so `/about/careers` and `/about/careers/` are distinct rows.
// Config URLs may be written either way. To avoid silent misses, add BOTH
// variants of each path to the filter and the reverse-lookup map; both
// variants resolve back to the same canonical config URL.
const urlToPath = {};
const pagePathToUrl = {};
for (const url of (cfg.urls || [])) {
  try {
    const u = new URL(url);
    const p = u.pathname || '/';
    urlToPath[url] = p;
    pagePathToUrl[p] = url;
    // Add the complement (with vs without trailing slash). Skip for "/" itself.
    if (p !== '/') {
      const alt = p.endsWith('/') ? p.slice(0, -1) : p + '/';
      if (!(alt in pagePathToUrl)) pagePathToUrl[alt] = url;
    }
  } catch (e) {
    console.warn(`Skipping unparseable URL: ${url}`);
  }
}
const pagePaths = Object.keys(pagePathToUrl);
if (pagePaths.length === 0) {
  console.error('No parseable URLs in config.urls. Nothing to query.');
  writeAndExit({ urls: {} });
}

console.log(`URLs:      ${pagePaths.length} pagePaths to query`);

// --- Run the report -------------------------------------------------------

(async function main() {
  let BetaAnalyticsDataClient;
  try {
    BetaAnalyticsDataClient = require('@google-analytics/data').BetaAnalyticsDataClient;
  } catch (e) {
    console.error(`Cannot load @google-analytics/data: ${e.message}`);
    console.error(`Run "npm ci" or "npm install" to install the dependency.`);
    writeAndExit({ error: 'missing @google-analytics/data dependency', urls: {} }, 0);
    return;
  }

  const client = new BetaAnalyticsDataClient({ credentials });

  let response;
  try {
    const [resp] = await client.runReport({
      property: `properties/${ga4Cfg.propertyId}`,
      dimensions: [
        { name: 'pagePath' },
        { name: 'deviceCategory' },
      ],
      metrics: [
        { name: 'screenPageViews' },
        { name: 'activeUsers' },
        { name: 'userEngagementDuration' },
        { name: 'keyEvents' },
      ],
      dateRanges: [{ startDate, endDate }],
      dimensionFilter: {
        filter: {
          fieldName: 'pagePath',
          inListFilter: { values: pagePaths },
        },
      },
      limit: 1000,  // 10 URLs * 3 device categories = 30 rows worst case; 1000 is plenty
    });
    response = resp;
  } catch (e) {
    console.error(`GA4 runReport failed: ${e.message}`);
    writeAndExit({ error: `runReport failed: ${e.message}`, urls: {} }, 0);
    return;
  }

  // --- Aggregate to per-URL, per-device ----------------------------------

  const out = {};
  let counted = 0;
  let skippedTablet = 0;
  let unmatchedPaths = 0;

  for (const row of (response.rows || [])) {
    const pagePath = row.dimensionValues[0].value;
    const device = row.dimensionValues[1].value;
    const fullUrl = pagePathToUrl[pagePath];
    if (!fullUrl) { unmatchedPaths++; continue; }
    if (device !== 'mobile' && device !== 'desktop') { skippedTablet++; continue; }

    const views    = parseInt(row.metricValues[0].value || '0', 10);
    const users    = parseInt(row.metricValues[1].value || '0', 10);
    const engSecs  = parseFloat(row.metricValues[2].value || '0');  // total seconds across users
    const keyEvts  = parseInt(row.metricValues[3].value || '0', 10);

    if (!out[fullUrl]) out[fullUrl] = {};
    // Sum totals when a canonical URL gets hit by multiple path variants
    // (e.g. /about/careers and /about/careers/). Engagement gets recomputed
    // as a user-weighted average after the loop so duration totals stay correct.
    const acc = out[fullUrl][device] || { views: 0, users: 0, _engSecs: 0, keyEvents: 0 };
    acc.views     += views;
    acc.users     += users;
    acc._engSecs  += engSecs;
    acc.keyEvents += keyEvts;
    out[fullUrl][device] = acc;
    counted++;
  }

  // GA4 userEngagementDuration is total seconds across users. The dashboard's
  // "Engage" shows avg per active user, in ms. Compute it now (after summing
  // across variants) so the average is correctly user-weighted.
  for (const url of Object.keys(out)) {
    for (const device of Object.keys(out[url])) {
      const a = out[url][device];
      a.engagementMs = Math.round((a._engSecs / Math.max(1, a.users)) * 1000);
      delete a._engSecs;
    }
  }

  // Fill missing device blocks with zeros so the dashboard's delta math doesn't
  // skip rows that had data on mobile but not desktop (or vice versa).
  for (const url of Object.keys(out)) {
    for (const device of ['mobile', 'desktop']) {
      if (!out[url][device]) {
        out[url][device] = { views: 0, users: 0, engagementMs: 0, keyEvents: 0 };
      }
    }
  }

  const urlCount = Object.keys(out).length;
  console.log(`Rows:      ${counted} counted, ${skippedTablet} tablet rows skipped, ${unmatchedPaths} unmatched paths`);
  console.log(`URLs out:  ${urlCount} of ${pagePaths.length} pagePaths returned data`);

  // Surface URLs in config that returned ZERO data so trailing-slash mismatches
  // or other path drift get caught early. Dedupe (Object.values includes both
  // path variants pointing at the same canonical URL).
  const missingUrls = [...new Set(Object.values(pagePathToUrl).filter(u => !out[u]))];
  if (missingUrls.length) {
    console.log(`Missing:   ${missingUrls.length} URL(s) returned no GA4 data:`);
    for (const u of missingUrls.slice(0, 5)) console.log(`             - ${u}`);
    if (missingUrls.length > 5) console.log(`             (and ${missingUrls.length - 5} more)`);
  }

  writeAndExit({ urls: out });
})().catch(e => {
  console.error(`Unexpected error: ${e.stack || e.message}`);
  writeAndExit({ error: `unexpected: ${e.message}`, urls: {} }, 0);
});

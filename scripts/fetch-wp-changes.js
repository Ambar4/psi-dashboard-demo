#!/usr/bin/env node
// fetch-wp-changes.js
// Pulls modified pages and posts (and templates if the site is a block theme)
// from a client's WordPress REST API for the window between the previous
// snapshot date and the snapshot date being built. Writes results to
// clients/<client>/psi-raw/<snapshot-id>/wordpress.json so build-snapshot.js
// can fold them into the snapshot.
//
// Usage:
//   node scripts/fetch-wp-changes.js <client> [snapshot-id]
//
// Auth: reads the app password from env var <CLIENT_UPPER>_WP_APP_PASSWORD
// (e.g. ACME_WP_APP_PASSWORD for a client with id "acme"). Username comes
// from config.
//
// Skips silently (writes an empty items file) if:
//   - the client config has no `wordpress` block, or
//   - `wordpress.enabled` is false, or
//   - the env var holding the password is unset.
// This lets local runs without WP creds still produce a valid snapshot.

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.dirname(SCRIPT_DIR);

const CLIENT = process.argv[2];
const SNAPSHOT_ID = process.argv[3] || new Date().toISOString().slice(0, 10);

if (!CLIENT) {
  console.error('Usage: node fetch-wp-changes.js <client> [snapshot-id]');
  process.exit(2);
}

const CLIENT_DIR = path.join(ROOT_DIR, 'clients', CLIENT);
const CONFIG_PATH = path.join(CLIENT_DIR, 'config.json');
const INDEX_PATH = path.join(CLIENT_DIR, 'snapshots', 'index.json');
const RAW_DIR = path.join(CLIENT_DIR, 'psi-raw', SNAPSHOT_ID);
const OUT_FILE = path.join(RAW_DIR, 'wordpress.json');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Config not found: ${CONFIG_PATH}`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const wpCfg = cfg.wordpress;
if (!wpCfg || wpCfg.enabled === false) {
  console.log(`No wordpress config or disabled for ${CLIENT}. Skipping WP fetch.`);
  ensureDir(RAW_DIR);
  fs.writeFileSync(OUT_FILE, JSON.stringify({ items: [] }, null, 2) + '\n');
  process.exit(0);
}

const envVar = `${CLIENT.toUpperCase()}_WP_APP_PASSWORD`;
const APP_PASSWORD = process.env[envVar];
if (!APP_PASSWORD) {
  console.log(`${envVar} not set. Skipping WP fetch.`);
  ensureDir(RAW_DIR);
  fs.writeFileSync(OUT_FILE, JSON.stringify({ items: [] }, null, 2) + '\n');
  process.exit(0);
}

const SITE_URL = (wpCfg.siteUrl || '').replace(/\/$/, '');
const USERNAME = wpCfg.username;
const PUBLIC_HOST = (() => {
  try { return new URL(cfg.baseUrl).host; } catch (e) { return ''; }
})();
const WP_HOST = (() => {
  try { return new URL(SITE_URL).host; } catch (e) { return ''; }
})();

if (!SITE_URL || !USERNAME) {
  fail(`Bad wordpress config: siteUrl and username required.`);
}

const AUTH_HEADER = 'Basic ' + Buffer.from(`${USERNAME}:${APP_PASSWORD}`).toString('base64');

// --- Time window ----------------------------------------------------------

// Mirrors fetch-changes.sh: window is (prevSnapshotDate 23:59:59, snapshotDate 23:59:59].
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
  return {
    since: `${prevDate}T23:59:59Z`,
    until: `${SNAPSHOT_ID}T23:59:59Z`,
    prevDate,
  };
}

const { since: SINCE, until: UNTIL, prevDate } = computeWindow();

console.log(`Client:    ${CLIENT}`);
console.log(`WP site:   ${SITE_URL}`);
console.log(`Window:    ${SINCE}  ->  ${UNTIL}`);

// --- Fetch helpers --------------------------------------------------------

async function wpGet(pathAndQuery) {
  const url = `${SITE_URL}/wp-json/wp/v2/${pathAndQuery}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': AUTH_HEADER,
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

// Rewrite the WP-returned link from the origin host to the public host, if they differ.
// E.g. https://origin.example.com/about/ -> https://www.example.com/about/
function publicizeUrl(link) {
  if (!link || !PUBLIC_HOST || !WP_HOST || PUBLIC_HOST === WP_HOST) return link;
  try {
    const u = new URL(link);
    if (u.host === WP_HOST) {
      u.host = PUBLIC_HOST;
      u.protocol = 'https:';
      return u.toString();
    }
    return link;
  } catch (e) {
    return link;
  }
}

function editUrl(id) {
  return `${SITE_URL}/wp-admin/post.php?post=${id}&action=edit`;
}

// Inside the time window, on title.rendered, exclude drafts/trash, fold _embed author.
function normalizeItem(raw, type) {
  const embeddedAuthor = raw._embedded && raw._embedded.author && raw._embedded.author[0];
  const authorName = (embeddedAuthor && embeddedAuthor.name) || 'Unknown';
  const modified = raw.modified_gmt
    ? raw.modified_gmt + 'Z'
    : (raw.modified ? raw.modified + 'Z' : null);
  return {
    type,
    title: (raw.title && (raw.title.rendered || raw.title.raw)) || `(untitled ${type})`,
    date: modified,
    author: authorName,
    url: publicizeUrl(raw.link),
    editUrl: editUrl(raw.id),
    id: raw.id,
    status: raw.status,
  };
}

async function fetchCollection(endpoint, type) {
  // modified_after is exclusive on the upper bound natively; we filter to <= UNTIL after.
  // per_page=100 is the WP REST max; we accept that as the cap for a weekly window.
  const query = new URLSearchParams({
    modified_after: SINCE,
    per_page: '100',
    orderby: 'modified',
    order: 'desc',
    status: 'publish',
    context: 'view',
    _embed: 'author',
  });
  try {
    const list = await wpGet(`${endpoint}?${query.toString()}`);
    const items = Array.isArray(list) ? list : [];
    return items
      .filter(p => {
        if (!p.modified_gmt) return true;
        const iso = p.modified_gmt + 'Z';
        return iso <= UNTIL;
      })
      .map(p => normalizeItem(p, type));
  } catch (e) {
    // 404 on wp_template_part is the "classic theme" signal; surface it as info, not error.
    if (endpoint === 'wp_template_part' && /HTTP 404/.test(e.message)) {
      console.log(`Templates endpoint not available (classic theme). Skipping.`);
      return [];
    }
    throw new Error(`Fetch ${endpoint} failed: ${e.message}`);
  }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function fail(message) {
  console.error(message);
  ensureDir(RAW_DIR);
  fs.writeFileSync(OUT_FILE, JSON.stringify({ error: message, items: [] }, null, 2) + '\n');
  process.exit(0);  // exit 0 so the workflow continues; surface error in the JSON.
}

// --- Main -----------------------------------------------------------------

(async function main() {
  ensureDir(RAW_DIR);

  let items = [];
  const errors = [];

  // Quick auth check via /users/me. Surfaces a clear error if app password is wrong
  // before we hammer the collection endpoints.
  try {
    const me = await wpGet('users/me');
    console.log(`Authed as: ${me.name || me.slug || me.id}`);
  } catch (e) {
    return fail(`WP auth failed: ${e.message}`);
  }

  try {
    const pages = await fetchCollection('pages', 'wp-page');
    items.push(...pages);
    console.log(`  Pages:     ${pages.length}`);
  } catch (e) {
    errors.push(`pages: ${e.message}`);
  }

  try {
    const posts = await fetchCollection('posts', 'wp-post');
    items.push(...posts);
    console.log(`  Posts:     ${posts.length}`);
  } catch (e) {
    errors.push(`posts: ${e.message}`);
  }

  try {
    const templates = await fetchCollection('wp_template_part', 'wp-template');
    items.push(...templates);
    if (templates.length) console.log(`  Templates: ${templates.length}`);
  } catch (e) {
    errors.push(`templates: ${e.message}`);
  }

  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const out = errors.length
    ? { items, error: errors.join(' | ') }
    : { items };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${items.length} WP change(s) to ${OUT_FILE}`);
  if (errors.length) console.error(`WARN: partial errors: ${errors.join(' | ')}`);
})().catch(e => fail(`Unexpected error: ${e.stack || e.message}`));

#!/usr/bin/env node
// record-rrweb.js
// Records rrweb event streams for one client's URL list via headless Chrome.
// Records BOTH mobile (throttled, matching Lighthouse mobile preset) and
// desktop (unthrottled). Saves JSON files to
// clients/<client>/rrweb-recordings/<snapshot-id>/ which the dashboard loads
// on demand for replay.
//
// Usage:
//   node scripts/record-rrweb.js <client> [snapshot-id]
//
// Mobile is the interesting replay because throttling forces a progressive
// render that rrweb can capture as a stream of DOM mutations. Desktop loads so
// fast that the replay is close to a static snapshot.

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const ROOT_DIR = path.dirname(SCRIPT_DIR);

const CLIENT = process.argv[2];
const SNAPSHOT_ID = process.argv[3] || new Date().toISOString().slice(0, 10);

if (!CLIENT) {
  console.error('Usage: node record-rrweb.js <client> [snapshot-id]');
  process.exit(2);
}

const CLIENT_DIR = path.join(ROOT_DIR, 'clients', CLIENT);
const CONFIG_PATH = path.join(CLIENT_DIR, 'config.json');
const OUT_DIR = path.join(CLIENT_DIR, 'rrweb-recordings', SNAPSHOT_ID);

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

const RRWEB_VERSION = '2.0.0-alpha.11';
const RRWEB_LOCAL = path.join(SCRIPT_DIR, `.rrweb-${RRWEB_VERSION}.min.js`);
const RRWEB_CDN = `https://cdn.jsdelivr.net/npm/rrweb@${RRWEB_VERSION}/dist/rrweb.min.js`;

// Lighthouse presets:
//   mobile: Moto G Power viewport, slow 4G (1.6Mbps/750Kbps/150ms), 4x CPU
//   desktop: 1440x900, unthrottled
const STRATEGIES = {
  mobile: {
    viewport: { width: 412, height: 823, isMobile: true, hasTouch: true, deviceScaleFactor: 1.75 },
    userAgent:
      'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    network: {
      offline: false,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
      latency: 150,
    },
    cpuThrottling: 4,
    postLoadWaitMs: 8000,
    navTimeoutMs: 90000,
  },
  desktop: {
    viewport: { width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    network: null,
    cpuThrottling: 1,
    postLoadWaitMs: 5000,
    navTimeoutMs: 60000,
  },
};

function ensureRrwebLocal() {
  if (fs.existsSync(RRWEB_LOCAL) && fs.statSync(RRWEB_LOCAL).size > 10000) return;
  console.log(`Downloading rrweb ${RRWEB_VERSION}...`);
  execSync(`curl -sSL --fail -o "${RRWEB_LOCAL}" "${RRWEB_CDN}"`, { stdio: 'inherit' });
}

async function recordOne(browser, url, idx, strategy, rrwebSource) {
  const cfg = STRATEGIES[strategy];
  const page = await browser.newPage();
  await page.setViewport(cfg.viewport);
  await page.setUserAgent(cfg.userAgent);

  await page.evaluateOnNewDocument(rrwebSource);
  await page.evaluateOnNewDocument(() => {
    window.__rrwebEvents = [];
    window.__rrwebError = null;
    try {
      if (typeof rrweb === 'undefined' || !rrweb.record) {
        window.__rrwebError = 'rrweb not defined after injection';
        return;
      }
      window.__rrwebStop = rrweb.record({
        emit(event) { window.__rrwebEvents.push(event); },
        recordCanvas: false,
        collectFonts: false,
      });
    } catch (e) {
      window.__rrwebError = String((e && e.stack) || e);
    }
  });

  const client = await page.target().createCDPSession();
  await client.send('Network.enable');
  if (cfg.network) {
    await client.send('Network.emulateNetworkConditions', cfg.network);
  }
  if (cfg.cpuThrottling > 1) {
    await client.send('Emulation.setCPUThrottlingRate', { rate: cfg.cpuThrottling });
  }

  const start = Date.now();
  let navError = null;
  console.log(`[${String(idx + 1).padStart(2)}/${URLS.length}] ${strategy.padEnd(7)} ${url}`);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: cfg.navTimeoutMs });
  } catch (e) {
    navError = e.message.split('\n')[0];
  }

  try {
    await page.evaluate(() => {
      window.scrollTo({ top: 600, behavior: 'smooth' });
      setTimeout(() => window.scrollTo({ top: 1200, behavior: 'smooth' }), 1500);
      setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 3500);
    });
  } catch (e) {}

  await new Promise(r => setTimeout(r, cfg.postLoadWaitMs));

  const result = await page.evaluate(() => {
    if (typeof window.__rrwebStop === 'function') {
      try { window.__rrwebStop(); } catch (e) {}
    }
    return { events: window.__rrwebEvents || [], error: window.__rrwebError };
  });

  const elapsed = Math.round((Date.now() - start) / 1000);
  const outfile = path.join(OUT_DIR, `url-${idx}-${strategy}-rrweb.json`);
  const durationS = result.events.length >= 2
    ? ((result.events[result.events.length - 1].timestamp - result.events[0].timestamp) / 1000).toFixed(1)
    : '0.0';
  fs.writeFileSync(outfile, JSON.stringify({
    url,
    strategy,
    viewport: { width: cfg.viewport.width, height: cfg.viewport.height },
    capturedAt: new Date().toISOString(),
    events: result.events,
  }));
  const sizeKb = (fs.statSync(outfile).size / 1024).toFixed(1);
  const notes = [
    `${result.events.length} events`,
    `${durationS}s replay`,
    `${sizeKb} KB`,
    `${elapsed}s elapsed`,
    navError && `nav:${navError}`,
    result.error && `rrweb:${result.error}`,
  ].filter(Boolean).join('  |  ');
  console.log(`        ${notes}`);

  await page.close();
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  ensureRrwebLocal();
  const rrwebSource = fs.readFileSync(RRWEB_LOCAL, 'utf8');

  console.log(`Client:   ${CLIENT}`);
  console.log(`Snapshot: ${SNAPSHOT_ID}`);
  console.log(`Output:   ${OUT_DIR}`);
  console.log(`Recording ${URLS.length} URLs x 2 strategies. ~6-8 min total.\n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    for (const strategy of ['mobile', 'desktop']) {
      console.log(`\n=== ${strategy.toUpperCase()} batch ===\n`);
      for (let i = 0; i < URLS.length; i++) {
        try {
          await recordOne(browser, URLS[i], i, strategy, rrwebSource);
        } catch (e) {
          console.error(`        FAIL: ${e.message}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  // Write a per-client/per-snapshot index so the dashboard can know which recordings exist.
  const idx = [];
  for (let i = 0; i < URLS.length; i++) {
    for (const s of ['mobile', 'desktop']) {
      const p = path.join(OUT_DIR, `url-${i}-${s}-rrweb.json`);
      idx.push({
        index: i,
        url: URLS[i],
        strategy: s,
        file: `url-${i}-${s}-rrweb.json`,
        exists: fs.existsSync(p),
        sizeKb: fs.existsSync(p) ? Math.round(fs.statSync(p).size / 1024) : 0,
      });
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(idx, null, 2));

  console.log('\nDone. Files in ' + OUT_DIR + ':');
  for (const f of fs.readdirSync(OUT_DIR).sort()) {
    const s = fs.statSync(path.join(OUT_DIR, f));
    console.log(`  ${f}  (${(s.size / 1024).toFixed(1)} KB)`);
  }
})();

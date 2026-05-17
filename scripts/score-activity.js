// score-activity.js
// Rules-based inference for activity impact scoring. Takes an item shape
// (title, hypothesis, type, status, ...) and returns three likelihood scores
// (Speed / Traffic / Conversion) plus drivers explaining the score.
//
// Pure function. No I/O. build-snapshot.js calls this for items that don't
// already carry pre-authored scores (those come from the demo's static data
// files and win when present).
//
// Each rule is a regex against the lowercase title + hypothesis. Multiple
// rules can fire on one item; per-dimension we take the max value and resolve
// direction conflicts to 'Mixed'.

'use strict';

const CAP = 95;
const NEUTRAL_DEFAULT = 15;

// Each rule: {pattern, speed?, traffic?, conversion?, driver}
// Per-dimension score is { value: 0-100, direction: '<tag>' }.
const RULES = [
  // --- Speed-heavy patterns ---
  {
    pattern: /cookie\s*banner|cookie\s*consent|gdpr\s*consent|consent\s*banner/i,
    speed: { value: 80, direction: '-Perf' },
    conversion: { value: 30, direction: '-Conv' },
    driver: 'cookie / consent banner',
  },
  {
    pattern: /third[-\s]?party|\bpixel\b|tracking\s*tag|gtag|google\s*tag\s*manager|hubspot\s*script|hotjar|analytics\s*script/i,
    speed: { value: 75, direction: '-Perf' },
    driver: 'third-party script / tag',
  },
  {
    pattern: /\bfont\b|webfont|typeface|@font-face/i,
    speed: { value: 50, direction: '-Perf' },
    driver: 'font change',
  },
  {
    pattern: /(?:^|\W)(image|images|png|jpg|jpeg|webp|svg|asset|assets)(?=\W|$)/i,
    speed: { value: 45, direction: '-Perf' },
    driver: 'image / asset change',
  },
  {
    pattern: /optimi[sz]e|compress|lazy[-\s]?load|defer\s*script|reduce\s*bundle|minif/i,
    speed: { value: 55, direction: '+Speed' },
    driver: 'optimization work',
  },
  {
    pattern: /\bhero\b|above[-\s]the[-\s]fold|\batf\b|landing\s*banner/i,
    speed: { value: 55, direction: '-Perf' },
    conversion: { value: 55, direction: '+Conv' },
    driver: 'above-the-fold layout',
  },
  {
    pattern: /\blcp\b|\bcls\b|\btbt\b|core\s*web\s*vitals|cwv|web\s*vitals/i,
    speed: { value: 65, direction: '+Speed' },
    driver: 'Core Web Vitals work',
  },
  {
    // "bundle" alone false-positives on "bundle pricing", "bundle units", etc.
    // Require a code/JS qualifier.
    pattern: /\bjs\s*bundle|\bcode\s*bundle|webpack|rollup|\bvite\b|tree[-\s]?shak|chunk\s*(splitting|size)/i,
    speed: { value: 45, direction: '-Perf' },
    driver: 'JS bundle change',
  },
  {
    pattern: /\bvideo\b|hls|mp4|autoplay/i,
    speed: { value: 60, direction: '-Perf' },
    driver: 'video asset',
  },

  // --- Traffic-heavy patterns ---
  {
    pattern: /redirect|canonical|301|302/i,
    speed: { value: 25, direction: '-Perf' },
    traffic: { value: 85, direction: '+Traffic' },
    driver: 'redirect / canonical change',
  },
  {
    pattern: /noindex|unpublish|\bremoved?\b|\bdelet(?:e|ed)\b|\bretired\b/i,
    traffic: { value: 90, direction: '-Traffic' },
    driver: 'page removed / de-indexed',
  },
  {
    pattern: /meta\s*title|meta\s*description|og:|open\s*graph|seo\s*tag|page\s*title/i,
    traffic: { value: 60, direction: '+Traffic' },
    driver: 'SEO metadata update',
  },
  {
    pattern: /sitemap|robots\.txt|hreflang|schema\.org|json[-\s]?ld/i,
    traffic: { value: 65, direction: '+Traffic' },
    driver: 'crawl / indexing config',
  },
  {
    pattern: /internal\s*link|breadcrumb|related\s*posts|related\s*articles/i,
    traffic: { value: 55, direction: '+Traffic' },
    driver: 'internal linking change',
  },
  {
    pattern: /\b(new|publish|launched?|released?|added?)\b.*\b(article|post|guide|blog|story|piece)\b/i,
    speed: { value: 20, direction: '-Perf' },
    traffic: { value: 75, direction: '+Traffic' },
    driver: 'new indexed content',
  },
  {
    pattern: /category\s*(page|landing)|tag\s*page|archive\s*page/i,
    traffic: { value: 55, direction: '+Traffic' },
    driver: 'category / archive page',
  },
  {
    pattern: /(featured|highlighted|curated)\s*(articles?|content)\s*(refresh|update)?/i,
    traffic: { value: 60, direction: '+Traffic' },
    driver: 'curated content refresh',
  },

  // --- Conversion-heavy patterns ---
  {
    pattern: /\bcta\b|call[-\s]to[-\s]action|button\s*(text|copy|color|label|placement)/i,
    conversion: { value: 75, direction: '+Conv' },
    driver: 'CTA change',
  },
  {
    pattern: /pricing|price\s*change|price\s*test|bundle\s*price|plan\s*price|\$\d+\s*(vs|to|->)\s*\$\d+/i,
    conversion: { value: 90, direction: 'Mixed' },
    driver: 'pricing change',
  },
  {
    pattern: /checkout|\bcart\b|payment\s*flow|purchase\s*flow|stripe|paypal/i,
    conversion: { value: 92, direction: '+Conv' },
    driver: 'checkout / payment flow',
  },
  {
    pattern: /signup|sign[-\s]up|register|account\s*creation|onboarding|create\s*account/i,
    conversion: { value: 82, direction: '+Conv' },
    driver: 'signup / onboarding',
  },
  {
    pattern: /\bform\b|contact\s*form|lead\s*form|input\s*field/i,
    conversion: { value: 72, direction: '+Conv' },
    driver: 'form change',
  },
  {
    pattern: /newsletter|subscribe|email\s*capture|email\s*signup/i,
    conversion: { value: 78, direction: '+Conv' },
    traffic: { value: 35, direction: '+Traffic' },
    driver: 'newsletter / subscribe',
  },
  {
    pattern: /upsell|cross[-\s]sell|upgrade\s*prompt|\bmodal\b|post[-\s]purchase/i,
    conversion: { value: 80, direction: '+Conv' },
    speed: { value: 30, direction: '-Perf' },
    driver: 'upsell / modal',
  },
  {
    pattern: /pricing\s*page|plans?\s*page/i,
    conversion: { value: 80, direction: '+Conv' },
    driver: 'pricing-adjacent page',
  },
  {
    pattern: /\btrial\b|\bdemo\b|free\s*trial|book\s*demo|request\s*quote/i,
    conversion: { value: 72, direction: '+Conv' },
    driver: 'trial / demo flow',
  },
  {
    pattern: /trust\s*badge|testimonial|\breview(s)?\b|social\s*proof/i,
    conversion: { value: 55, direction: '+Conv' },
    driver: 'trust signal',
  },
  {
    pattern: /navigation|nav\s*menu|main\s*nav|primary\s*menu|header\s*menu/i,
    speed: { value: 25, direction: '-Perf' },
    traffic: { value: 50, direction: '+Traffic' },
    conversion: { value: 50, direction: '+Conv' },
    driver: 'navigation change',
  },

  // --- WordPress / CMS-side content patterns ---
  {
    pattern: /(membership|tier|plan)\s*(update|change|page)/i,
    conversion: { value: 70, direction: '+Conv' },
    driver: 'membership / tier update',
  },
  {
    pattern: /(workshop|course|class|webinar|training)/i,
    conversion: { value: 58, direction: '+Conv' },
    traffic: { value: 40, direction: '+Traffic' },
    driver: 'workshop / training page',
  },
  {
    pattern: /\bbook\b|ebook|publication\s*(page|catalog)|printed\s*book/i,
    conversion: { value: 65, direction: '+Conv' },
    driver: 'book / catalog page',
  },
  {
    pattern: /wcag|accessibility\s*(guide|update|page)/i,
    traffic: { value: 50, direction: '+Traffic' },
    driver: 'accessibility-relevant content',
  },
];

// Status-based driver for experiment items. Status doesn't shift scores
// directly; the driver text just adds context to the tooltip.
function statusDriver(item) {
  if (item.type !== 'experiment') return null;
  const s = (item.status || '').toLowerCase();
  if (s === 'running')  return 'active variant exposure';
  if (s === 'stopped')  return 'concluded experiment';
  if (s === 'draft')    return 'draft (not yet exposed)';
  return null;
}

// Type-based driver for content items. Adds dimension context for WP pages.
function typeDriver(item) {
  switch (item && item.type) {
    case 'wp-page':       return 'WordPress page edit';
    case 'wp-post':       return 'WordPress post edit';
    case 'wp-template':   return 'WordPress template (sitewide impact)';
    default:              return null;
  }
}

// Bug-fix / chore detector. Short-circuits to all-Neutral when the title is
// pure maintenance and no high-signal keyword overrides it.
function looksLikeChoreOnly(text) {
  return /(?:^|\W)(fix|bug\s*fix|hotfix|patch|refactor|cleanup|chore|typo|test|ci|deps|lint|wip|update\s*dependencies)\b/i.test(text)
      && !/(cookie|cta|pricing|checkout|signup|hero|font|image|noindex|redirect|nav|newsletter|form|membership|book|workshop)/i.test(text);
}

// Merge a rule's dimension contribution into the current per-dim score.
// Takes the max value; resolves direction conflicts to 'Mixed' (unless one
// side is 'Neutral', in which case the non-Neutral wins).
function applyRule(curr, incoming) {
  if (!incoming) return curr;
  const incVal = Math.min(CAP, incoming.value);
  if (!curr) return { value: incVal, direction: incoming.direction };
  const value = Math.max(curr.value, incVal);
  let direction;
  if (curr.direction === incoming.direction) {
    direction = curr.direction;
  } else if (curr.direction === 'Neutral') {
    direction = incoming.direction;
  } else if (incoming.direction === 'Neutral') {
    direction = curr.direction;
  } else {
    direction = 'Mixed';
  }
  return { value, direction };
}

function neutralDefault() {
  return { value: NEUTRAL_DEFAULT, direction: 'Neutral' };
}

function scoreItem(item) {
  if (!item) return { scores: null, drivers: [] };
  const title = String(item.title || '').toLowerCase();
  const hypothesis = String(item.hypothesis || '').toLowerCase();
  const text = (title + ' ' + hypothesis).trim();

  if (!text) {
    return {
      scores: { speed: neutralDefault(), traffic: neutralDefault(), conversion: neutralDefault() },
      drivers: [],
    };
  }

  if (looksLikeChoreOnly(text)) {
    return {
      scores: { speed: neutralDefault(), traffic: neutralDefault(), conversion: neutralDefault() },
      drivers: ['bug fix / chore'],
    };
  }

  let speed = null, traffic = null, conversion = null;
  const driverSet = new Set();

  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;
    speed      = applyRule(speed,      rule.speed);
    traffic    = applyRule(traffic,    rule.traffic);
    conversion = applyRule(conversion, rule.conversion);
    if (rule.driver) driverSet.add(rule.driver);
  }

  // Status driver adds context without shifting scores.
  const sd = statusDriver(item);
  if (sd) driverSet.add(sd);
  const td = typeDriver(item);
  if (td) driverSet.add(td);

  // Type-based defaults. Posts (wp-post / tina-post) imply new indexed content
  // even when the title has no explicit "new article" keyword, so bump Traffic
  // to at least mid-Possible. Same logic for category/archive pages.
  const t = item && item.type;
  if (t === 'wp-post' || t === 'tina-post') {
    traffic = applyRule(traffic, { value: 50, direction: '+Traffic' });
    if (!Array.from(driverSet).some(d => d.includes('indexed') || d.includes('post'))) {
      driverSet.add('post (indexed content)');
    }
  }

  return {
    scores: {
      speed:      speed      || neutralDefault(),
      traffic:    traffic    || neutralDefault(),
      conversion: conversion || neutralDefault(),
    },
    drivers: Array.from(driverSet).slice(0, 4),
  };
}

module.exports = { scoreItem };

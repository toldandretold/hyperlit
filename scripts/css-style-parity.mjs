/**
 * css-style-parity.mjs — tier-2 regression gate for INTENTIONAL CSS changes
 * (dedup / consolidation / co-location), where source-level byte-identity
 * (scripts/css-cascade-snapshot.mjs) can't apply because the rules really change.
 *
 * It renders key pages/states in a real browser, dumps getComputedStyle for
 * EVERY element (plus ::before/::after pseudo-elements that render content),
 * and diffs the result against a saved baseline. If a consolidation changed
 * which rule wins anywhere, the computed values change and the diff names the
 * element and properties.
 *
 * Usage (server must be running; uses tests/e2e/.env.e2e for base URL + creds):
 *   node scripts/css-style-parity.mjs save       # baseline, BEFORE the change
 *   node scripts/css-style-parity.mjs compare    # after the change
 *   node scripts/css-style-parity.mjs selftest   # save+compare with no change (determinism check)
 *
 * States captured (each at desktop 1280x800 and mobile 390x844):
 *   home            — the homepage feed
 *   reader          — E2E_READER_BOOK open
 *   reader-settings — reader with the settings container open
 *   user            — /u/E2E_TEST_USERNAME
 *
 * Determinism measures: animations are seeked to t=0 and paused before capture;
 * the DOM is polled until its element count is stable; body scroll pinned to top.
 * Run `selftest` after changing states to confirm a clean baseline diff.
 *
 * Snapshots live in .css-style-parity/ (gitignored — migration tool, not CI).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SNAP_DIR = path.join(ROOT, '.css-style-parity');

// Load tests/e2e/.env.e2e (same loader as playwright.config.js)
try {
  const envContent = fs.readFileSync(path.join(ROOT, 'tests/e2e/.env.e2e'), 'utf8');
  for (const line of envContent.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    if (!process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
} catch { /* rely on real env */ }

const BASE = process.env.E2E_BASE_URL || 'http://localhost:8000';
const BOOK = process.env.E2E_READER_BOOK;
const USERNAME = process.env.E2E_TEST_USERNAME;
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
];

// ---------------------------------------------------------------- capture

// Wait until the element count stops changing (lazy loading / SPA boot settled).
async function waitForStableDom(page, { settleMs = 1500, timeoutMs = 30000 } = {}) {
  await page.waitForFunction(
    (settle) => {
      const w = window;
      const count = document.querySelectorAll('*').length;
      const now = Date.now();
      if (w.__parityCount !== count) {
        w.__parityCount = count;
        w.__parityStamp = now;
        return false;
      }
      return now - (w.__parityStamp || 0) >= settle;
    },
    settleMs,
    { timeout: timeoutMs, polling: 250 }
  );
}

async function freezeAndCapture(page) {
  return page.evaluate(() => {
    // Determinism: park every animation at t=0, pause videos, pin scroll.
    for (const a of document.getAnimations()) {
      try { a.currentTime = 0; a.pause(); } catch { /* infinite/CSS anims can throw */ }
    }
    for (const v of document.querySelectorAll('video, audio')) { try { v.pause(); } catch {} }
    window.scrollTo(0, 0);

    const keyCounts = new Map();
    const out = {};
    const walk = document.querySelectorAll('*');
    for (const el of walk) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'LINK' || el.tagName === 'META') continue;
      let key = el.tagName.toLowerCase();
      if (el.id) key += '#' + el.id;
      if (el.classList.length) key += '.' + [...el.classList].sort().join('.');
      const n = (keyCounts.get(key) || 0) + 1;
      keyCounts.set(key, n);
      key += `~${n}`;

      // Store prop->value objects, NOT joined strings: Chrome's enumeration
      // order of custom properties varies between page loads, so string
      // comparison false-positives on identical styles.
      const cs = getComputedStyle(el);
      const props = {};
      for (let i = 0; i < cs.length; i++) {
        const p = cs[i];
        // 'd' reflects SVG path data — the homepage hill art is procedurally
        // generated per load, so its coordinates are noise, not CSS.
        if (p === 'd') continue;
        props[p] = cs.getPropertyValue(p);
      }
      out[key] = props;

      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content && ps.content !== 'none') {
          const pprops = {};
          for (let i = 0; i < ps.length; i++) {
            const p = ps[i];
            pprops[p] = ps.getPropertyValue(p);
          }
          out[key + pseudo] = pprops;
        }
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------- states

async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const emailInput = page.locator('input[name="email"], input[type="email"]');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await emailInput.isVisible().catch(() => false)) break;
    await page.click('#userButton').catch(() => {});
    await page.waitForTimeout(500);
  }
  await page.fill('input[name="email"], input[type="email"]', process.env.E2E_USER_EMAIL || '');
  await page.fill('input[name="password"], input[type="password"]', process.env.E2E_USER_PASSWORD || '');
  while (Date.now() < deadline) {
    await page.evaluate(() => {
      const btn = document.querySelector('#loginSubmit') || document.querySelector('button[type="submit"]');
      if (btn) btn.click();
    });
    await page.waitForTimeout(1500);
    const stillOpen = await emailInput.isVisible().catch(() => false);
    if (!stillOpen) return;
  }
  throw new Error('login did not complete');
}

const STATES = {
  async home(page) {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await waitForStableDom(page);
  },
  async reader(page) {
    if (!BOOK) throw new Error('E2E_READER_BOOK not set');
    await page.goto(`${BASE}/${BOOK}`, { waitUntil: 'domcontentloaded' });
    await waitForStableDom(page);
  },
  async 'reader-settings'(page) {
    if (!BOOK) throw new Error('E2E_READER_BOOK not set');
    await page.goto(`${BASE}/${BOOK}`, { waitUntil: 'domcontentloaded' });
    await waitForStableDom(page);
    await page.click('#settingsButton').catch(() => {});
    await page.waitForTimeout(1200); // slide-in transition
    await waitForStableDom(page, { settleMs: 1000 });
  },
  async user(page) {
    if (!USERNAME) throw new Error('E2E_TEST_USERNAME not set');
    await page.goto(`${BASE}/u/${USERNAME}`, { waitUntil: 'domcontentloaded' });
    await waitForStableDom(page);
  },
};

// ---------------------------------------------------------------- run

async function captureAll() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'block' }); // sw.js serves stale assets in dev
  const page = await context.newPage();
  await login(page);

  const result = {};
  for (const [stateName, enter] of Object.entries(STATES)) {
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await enter(page);
      const snap = await freezeAndCapture(page);
      const label = `${stateName}@${vp.name}`;
      result[label] = snap;
      console.log(`captured ${label}  (${Object.keys(snap).length} elements)`);
    }
  }
  await browser.close();
  return result;
}

function diffSnapshots(before, after, label) {
  const bKeys = Object.keys(before);
  const aKeys = new Set(Object.keys(after));
  const missing = bKeys.filter((k) => !aKeys.has(k));
  const added = Object.keys(after).filter((k) => !(k in before));
  const changed = [];
  for (const k of bKeys) {
    if (!(k in after)) continue;
    const bProps = before[k];
    const aProps = after[k];
    const props = [];
    for (const p of new Set([...Object.keys(bProps), ...Object.keys(aProps)])) {
      if (bProps[p] !== aProps[p]) props.push(`${p}: '${bProps[p]}' -> '${aProps[p]}'`);
    }
    if (props.length) changed.push({ key: k, props });
  }
  const clean = !missing.length && !added.length && !changed.length;
  if (clean) {
    console.log(`OK      ${label}`);
    return true;
  }
  console.log(`DIFF    ${label}: ${changed.length} changed, ${added.length} added, ${missing.length} missing`);
  for (const c of changed.slice(0, 12)) {
    console.log(`   * ${c.key}`);
    for (const p of c.props.slice(0, 6)) console.log(`       ${p}`);
  }
  if (changed.length > 12) console.log(`   … and ${changed.length - 12} more changed elements`);
  for (const k of added.slice(0, 6)) console.log(`   + ${k}`);
  for (const k of missing.slice(0, 6)) console.log(`   - ${k}`);
  return false;
}

const mode = process.argv[2];
if (!['save', 'compare', 'selftest'].includes(mode)) {
  console.log('usage: node scripts/css-style-parity.mjs <save|compare|selftest>');
  process.exit(2);
}

const snaps = await captureAll();
fs.mkdirSync(SNAP_DIR, { recursive: true });
const snapFile = path.join(SNAP_DIR, 'baseline.json');

if (mode === 'save') {
  fs.writeFileSync(snapFile, JSON.stringify(snaps));
  console.log(`\nbaseline saved (${(fs.statSync(snapFile).size / 1e6).toFixed(1)} MB)`);
} else if (mode === 'compare' || mode === 'selftest') {
  if (mode === 'selftest') {
    // Immediately recapture and compare against what we just captured.
    fs.writeFileSync(snapFile, JSON.stringify(snaps));
    console.log('\nselftest: recapturing for determinism check…\n');
  }
  const baseline = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  const current = mode === 'selftest' ? await captureAll() : snaps;
  let ok = true;
  for (const label of Object.keys(baseline)) {
    ok = diffSnapshots(baseline[label], current[label] || {}, label) && ok;
  }
  if (!ok) {
    console.error('\ncomputed-style DIVERGENCE — inspect before shipping the CSS change.');
    process.exit(1);
  }
  console.log('\nAll states computed-style identical.');
}

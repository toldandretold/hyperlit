/**
 * /u/{username} page-load latency dashboard (real browser, real dev DB).
 *
 * Measures the perfMarks milestones (resources/js/utilities/perfMarks.ts) across
 * the three load shapes the user page actually has:
 *   COLD        — empty IndexedDB → /initial fetch + full background download
 *   WARM        — IDB populated, timestamps fresh → pure local render
 *   WARM-STALE  — {u}All's library.timestamp bumped server-side → IDB clear +
 *                 full redownload (the common "first load of the day" path)
 *
 * Philosophy: a dashboard you read, not a gate that flakes (see
 * tests/Feature/Api/Concurrency/). Everything lands in testInfo.annotations and
 * a JSON artifact under tests/e2e/test-results/perf/; the only hard assertions
 * are 3×-regression ceilings that should never flake.
 *
 * MUST run against a PRODUCTION BUILD (`npm run build`, Vite dev server OFF) —
 * latency through the dev server's unbundled module graph measures Vite, not
 * the app, so the spec skips itself (same policy as initial-load-size.spec.js).
 * The WARM-STALE phase shells out to `php artisan e2e:bump-book-timestamp`
 * (local-env-only seam) — Playwright runs on the same machine as Herd.
 *
 * Run: npm run test:perf:user-page
 * All phases share ONE test (and so one browser context): the restored-tab
 * localStorage stamped in the prologue is what makes later loads auto-open the
 * {u}All feed — the slow path under test.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';
import { startJsChunkCapture } from '../../helpers/networkCapture.js';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPEC_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SPEC_DIR, '..', '..', '..', '..');
const PERF_DIR = join(SPEC_DIR, '..', '..', 'test-results', 'perf');

/** Samples per scenario. Each is a full page load (seconds); keep tolerable. */
const SAMPLES = 3;

/**
 * Never-flake regression ceilings on p50 boot:total (DOMContentLoaded →
 * overlay hidden). Deliberately ~3× a bad-day local measurement — the real
 * output is the JSON artifact; these only catch a gross regression.
 */
const COLD_BOOT_TOTAL_CEILING_MS = 45_000;
const WARM_BOOT_TOTAL_CEILING_MS = 15_000;

/** Generous wait for the full background chunk download (multi-MB, serial batches). */
const BG_DOWNLOAD_TIMEOUT_MS = 180_000;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

async function wipeIndexedDB(page) {
  await page.evaluate(() => new Promise((res) => {
    const req = indexedDB.deleteDatabase('MarkdownDB');
    // onblocked is fine — open connections release on the next navigation and
    // the pending delete completes before the new page reopens the DB.
    req.onsuccess = req.onerror = req.onblocked = () => res(undefined);
  }));
}

async function waitForMark(page, mark, timeout) {
  await page.waitForFunction(
    (name) => performance.getEntriesByName(`hyperlit:${name}`, 'mark').length > 0,
    mark,
    { timeout },
  );
}

async function collectSample(page) {
  return page.evaluate(() => {
    const marks = {};
    const measures = {};
    for (const e of performance.getEntriesByType('mark')) {
      if (e.name.startsWith('hyperlit:')) marks[e.name.slice('hyperlit:'.length)] = Math.round(e.startTime);
    }
    for (const e of performance.getEntriesByType('measure')) {
      if (e.name.startsWith('hyperlit:')) measures[e.name.slice('hyperlit:'.length)] = Math.round(e.duration);
    }
    const nav = performance.getEntriesByType('navigation')[0];
    const registry = (window.buttonRegistry && typeof window.buttonRegistry.getStatus === 'function')
      ? window.buttonRegistry.getStatus().initTimes
      : null;
    return {
      marks,
      measures,
      serverTTFBMs: nav ? Math.round(nav.responseStart) : null,
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventStart) : null,
      componentInitMs: registry,
    };
  });
}

/**
 * One measured load. `prepare` runs before the navigation (IDB wipe, timestamp
 * bump); `expectDownload` additionally waits for the background download mark
 * — recorded separately so overlay time is never conflated with it.
 */
async function measureLoad(page, url, { prepare = null, expectDownload = false } = {}) {
  if (prepare) await prepare();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForMark(page, 'boot:overlay-hidden', 90_000);
  let downloadTimedOut = false;
  if (expectDownload) {
    try {
      await waitForMark(page, 'feed:background-download-done', BG_DOWNLOAD_TIMEOUT_MS);
    } catch {
      downloadTimedOut = true;
    }
  }
  const sample = await collectSample(page);
  sample.downloadTimedOut = downloadTimedOut;
  return sample;
}

function summarize(samples, milestoneKeys) {
  const summary = {};
  for (const key of milestoneKeys) {
    const values = samples.map((s) => s.marks[key]).filter((v) => typeof v === 'number');
    if (values.length) summary[key] = { p50: median(values), max: Math.max(...values), n: values.length };
  }
  const ttfbs = samples.map((s) => s.serverTTFBMs).filter((v) => typeof v === 'number');
  if (ttfbs.length) summary.serverTTFB = { p50: median(ttfbs), max: Math.max(...ttfbs), n: ttfbs.length };
  return summary;
}

const MILESTONES = [
  'boot:dom-ready',
  'boot:db-open',
  'boot:navigate-start',
  'feed:load-start',
  'feed:idb-read-done',
  'feed:first-chunk-rendered',
  'boot:overlay-hidden',
  'feed:background-download-done',
];

test.describe('user page load latency', () => {
  test('cold / warm / warm-stale load milestones', async ({ page }, testInfo) => {
    test.setTimeout(20 * 60 * 1000);
    test.skip(!!Number(process.env.E2E_SLOWMO || 0), 'E2E_SLOWMO poisons latency numbers — unset it');

    const username = process.env.E2E_TEST_USERNAME;
    test.skip(!username, 'E2E_TEST_USERNAME not set in .env.e2e');
    const userUrl = `/u/${username}`;
    const allBook = `${username}All`;

    const js = startJsChunkCapture(page);

    // ── Prologue (unmeasured): open the Library feed once so localStorage
    // remembers the tab — every later load then auto-opens the {u}All feed,
    // which is the slow path under test. Also warms the server-side caches
    // (hypercite map, BookCache) so client scenarios aren't polluted by a
    // server cold-cache.
    await page.goto(userUrl, { waitUntil: 'domcontentloaded' });
    await waitForMark(page, 'boot:overlay-hidden', 90_000);

    test.skip(
      js.snapshot().builtCount === 0,
      'No /build/assets chunks seen — dev-server latency measures Vite, not the app. ' +
        'Run `npm run build` with the Vite dev server off.',
    );
    js.stop();

    const libraryTab = page.locator('.arranger-button[data-filter="library"]');
    if (await libraryTab.count()) {
      const isActive = await libraryTab.first().evaluate((el) => el.classList.contains('active'));
      if (!isActive) await libraryTab.first().click();
    }
    await page.waitForSelector('.main-content .libraryCard', { timeout: 60_000 });

    const results = { when: new Date().toISOString(), username, samplesPerScenario: SAMPLES, scenarios: {} };

    // ── COLD: empty IndexedDB → /initial + full background download.
    const coldSamples = [];
    for (let i = 0; i < SAMPLES; i++) {
      coldSamples.push(await measureLoad(page, userUrl, {
        prepare: () => wipeIndexedDB(page),
        expectDownload: true,
      }));
    }
    results.scenarios.cold = { samples: coldSamples, summary: summarize(coldSamples, MILESTONES) };

    // ── WARM: IDB fully populated by the last cold download, timestamps fresh.
    const warmSamples = [];
    for (let i = 0; i < SAMPLES; i++) {
      warmSamples.push(await measureLoad(page, userUrl));
    }
    results.scenarios.warm = { samples: warmSamples, summary: summarize(warmSamples, MILESTONES) };

    // ── WARM-BUT-STALE: bump {u}All's server timestamp so the client sees its
    // local copy as stale → clear + full redownload. Bumping the feed book
    // itself (not a real book) deliberately does NOT trip the server-side
    // home-book regeneration, so this isolates the client stale path.
    const staleSamples = [];
    for (let i = 0; i < SAMPLES; i++) {
      staleSamples.push(await measureLoad(page, userUrl, {
        prepare: () => execSync(`php artisan e2e:bump-book-timestamp ${allBook}`, { cwd: PROJECT_ROOT, stdio: 'pipe' }),
        expectDownload: true,
      }));
    }
    // sync:clear only fires on this path — surface it in the summary too.
    results.scenarios.warmStale = {
      samples: staleSamples,
      summary: summarize(staleSamples, [...MILESTONES, 'sync:clear-start', 'sync:clear-done']),
    };
    const clearDurations = staleSamples
      .filter((s) => s.marks['sync:clear-start'] != null && s.marks['sync:clear-done'] != null)
      .map((s) => s.marks['sync:clear-done'] - s.marks['sync:clear-start']);
    if (clearDurations.length) {
      results.scenarios.warmStale.summary.idbClearDuration = { p50: median(clearDurations), max: Math.max(...clearDurations), n: clearDurations.length };
    }

    // ── Report: console table + annotations + JSON artifact.
    console.log(`\n⏱  /u/${username} load milestones (ms since navigation start, p50 of ${SAMPLES}):`);
    for (const [name, scenario] of Object.entries(results.scenarios)) {
      console.log(`  ${name}:`);
      for (const [key, stat] of Object.entries(scenario.summary)) {
        console.log(`    ${key.padEnd(32)} p50=${String(stat.p50).padStart(7)}  max=${String(stat.max).padStart(7)}`);
      }
      testInfo.annotations.push({
        type: `perf-${name}`,
        description: JSON.stringify(scenario.summary),
      });
    }

    mkdirSync(PERF_DIR, { recursive: true });
    const artifactPath = join(PERF_DIR, `user-page-load-${Date.now()}.json`);
    writeFileSync(artifactPath, JSON.stringify(results, null, 2));
    console.log(`\n📄 Perf artifact: ${artifactPath}`);

    // ── Ceilings: 3×-regression catches only. The dashboard above is the product.
    const coldTotal = results.scenarios.cold.summary['boot:overlay-hidden']?.p50;
    const warmTotal = results.scenarios.warm.summary['boot:overlay-hidden']?.p50;
    expect(
      coldTotal,
      `cold p50 overlay-hidden (${coldTotal}ms) should stay under the gross-regression ceiling ${COLD_BOOT_TOTAL_CEILING_MS}ms`,
    ).toBeLessThan(COLD_BOOT_TOTAL_CEILING_MS);
    expect(
      warmTotal,
      `warm p50 overlay-hidden (${warmTotal}ms) should stay under the gross-regression ceiling ${WARM_BOOT_TOTAL_CEILING_MS}ms`,
    ).toBeLessThan(WARM_BOOT_TOTAL_CEILING_MS);
  });
});

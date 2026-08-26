/**
 * Scroll forensics — the recorder + analyser behind specs/scroll-restore/.
 *
 * The reader's scroll lives on `.reader-content-wrapper` (html/body never
 * scroll), and a "shake" is: the wrapper's position keeps CHANGING after the
 * initial-navigation overlay is gone and the page looks settled. This helper
 * turns that into numbers:
 *
 *   1. attachScrollForensics(page) installs an init script (document-start,
 *      survives reload/SPA-nav/bfcache) that:
 *        - turns the app's own tracer on (`hyperlit_scroll_trace`, so
 *          lazyLoader's installScrollTrace tags every wrapper write with a
 *          reason + trimmed stack — see scrolling/scrollTrace.ts),
 *        - rAF-samples wrapper scrollTop every frame (catches changes from
 *          ANY cause — scrollIntoView, prepend compensation, layout shift
 *          moving content under a fixed scrollTop),
 *        - rAF-samples the rect of one tracked node (id passed via
 *          localStorage `__scroll_forensics_track` — set it with
 *          trackNodeAcrossNavigations so it survives reload),
 *        - logs pageshow/pagehide(persisted)/freeze/resume/visibilitychange.
 *   2. snapshotForensics(page) pulls the recorder + the app trace buffer.
 *   3. analyzeSettle(snap) computes: overlayHiddenAt, scroll-writes after that
 *      point, direction reversals (hysteresis 6px), settleMs, and the peak
 *      excursion of the tracked node's viewport position from its final value.
 *
 * Assertion style in specs: content may legitimately move WHILE the overlay is
 * up (restore is allowed to settle); after overlayHiddenAt the position must
 * converge and stay — count reversals/writes/excursion and bound them.
 *
 * On failure the full dump lands in tests/e2e/test-results/scroll-forensics/
 * (direct fs writes, same as the fixture's console-audit — testInfo.attach
 * silently drops bodies under our html reporter setup).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCROLLER = '.reader-content-wrapper';
const REVERSAL_HYSTERESIS_PX = 6;
const SAMPLE_CAP = 6000;

export const READER_SCROLLER = SCROLLER;

const FORENSICS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'test-results', 'scroll-forensics'
);

const INIT_FN = () => {
  try { localStorage.setItem('hyperlit_scroll_trace', 'true'); } catch (e) { /* private mode */ }

  const existing = window.__scrollForensics;
  if (existing && existing.recorder === 'scroll-restore') return; // survive SPA re-init

  const rec = {
    recorder: 'scroll-restore',
    samples: [],      // {t, top, overlayVisible}
    track: [],        // {t, top} for the tracked node (viewport-relative rect.top)
    events: [],       // {t, type, persisted?, state?}
    cap: 6000,
  };
  window.__scrollForensics = rec;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const pushSample = (arr, entry) => {
    arr.push(entry);
    if (arr.length > rec.cap) arr.shift();
  };

  for (const type of ['pageshow', 'pagehide']) {
    window.addEventListener(type, (e) => {
      rec.events.push({ t: now(), type, persisted: !!e.persisted });
    }, true);
  }
  for (const type of ['freeze', 'resume']) {
    document.addEventListener(type, () => rec.events.push({ t: now(), type }), true);
  }
  document.addEventListener('visibilitychange', () => {
    rec.events.push({ t: now(), type: 'visibilitychange', state: document.visibilityState });
  }, true);

  const overlayVisible = () => {
    const ov = document.getElementById('initial-navigation-overlay');
    if (!ov) return false;
    try { return getComputedStyle(ov).display !== 'none'; } catch (e) { return false; }
  };

  const tick = () => {
    const t = now();
    const wrapper = document.querySelector('.reader-content-wrapper');
    if (wrapper) {
      pushSample(rec.samples, { t, top: Math.round(wrapper.scrollTop * 10) / 10, overlayVisible: overlayVisible() });
    }
    let trackId = null;
    try { trackId = localStorage.getItem('__scroll_forensics_track'); } catch (e) { /* ignore */ }
    if (trackId) {
      const el = document.getElementById(trackId);
      if (el) {
        pushSample(rec.track, { t, top: Math.round(el.getBoundingClientRect().top * 10) / 10 });
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

/**
 * Install the recorder. Call BEFORE the first goto of the spec; survives
 * subsequent navigations automatically.
 */
export async function attachScrollForensics(page) {
  await page.addInitScript(INIT_FN);
}

/**
 * Track a node id across future navigations (reload/bfcache): its
 * viewport-relative rect.top is sampled each frame while it exists.
 */
export async function trackNodeAcrossNavigations(page, nodeId) {
  await page.addInitScript((id) => {
    try { localStorage.setItem('__scroll_forensics_track', id); } catch (e) { /* ignore */ }
  }, nodeId);
  await page.evaluate((id) => {
    try { localStorage.setItem('__scroll_forensics_track', id); } catch (e) { /* ignore */ }
  }, nodeId);
}

/** Read the app trace buffer without console.table side effects. */
function readAppTrace(page) {
  return page.evaluate(() => {
    const s = window.__scrollTrace;
    return s && Array.isArray(s.buffer) ? s.buffer.slice() : [];
  });
}

/** Pull recorder + app trace into one JSON-able snapshot. */
export async function snapshotForensics(page) {
  const rec = await page.evaluate(() => {
    const r = window.__scrollForensics;
    return r ? { samples: r.samples, track: r.track, events: r.events } : { samples: [], track: [], events: [] };
  });
  const trace = await readAppTrace(page);
  const imgComp = await page.evaluate(() => window.__imgComp || []);
  return { ...rec, trace, imgComp };
}

/**
 * Compute the settle metrics. `snap` is from snapshotForensics.
 *
 * overlayHiddenAt: first sample where the overlay is gone (null if never seen
 * hidden AND never seen visible — e.g. arm that never loaded the reader).
 * Post-hide metrics use wrapper samples with t >= overlayHiddenAt.
 *
 * reversals: turning points in the wrapper-top series with hysteresis — a
 * reversal counts only after the position moved >= 6px in the new direction.
 * settleMs: (last sample where wrapper top still changed) - overlayHiddenAt.
 * peakTrackExcursionPx: for the tracked node, max |top - finalTop| post-hide.
 */
/** Direction-reversal counter over a wrapper-top series (6px hysteresis) —
 *  exported for windowed (same-document / SPA) analyses; analyzeSettle uses it. */
export function countReversals(tops) {
  let reversals = 0;
  let lastSignificant = null;
  let direction = 0;
  for (let i = 1; i < tops.length; i++) {
    const prev = lastSignificant == null ? tops[i - 1] : lastSignificant;
    const delta = tops[i] - prev;
    if (Math.abs(delta) >= REVERSAL_HYSTERESIS_PX) {
      const dir = Math.sign(delta);
      if (direction !== 0 && dir !== direction) reversals++;
      direction = dir;
      lastSignificant = tops[i];
    }
  }
  return reversals;
}

export function analyzeSettle(snap, { fromIndex = 0 } = {}) {
  const allSamples = snap.samples || [];
  const samples = allSamples.slice(fromIndex);
  const trace = snap.trace || [];
  const track = snap.track || [];

  const windowStartT = fromIndex > 0 && allSamples[fromIndex - 1] ? allSamples[fromIndex - 1].t : null;

  // Windowed mode (SPA same-document nav): the overlay may not re-show, so
  // treat the window start as the "hide" line when the overlay never exists in
  // the window.
  const hiddenIdx = samples.findIndex((s) => !s.overlayVisible);
  const overlayHiddenAt = hiddenIdx >= 0 ? samples[hiddenIdx].t : (windowStartT ?? (samples[0]?.t ?? null));
  const post = overlayHiddenAt == null ? [] : samples.filter((s) => s.t >= overlayHiddenAt);

  const writes = trace.filter((e) => e.kind === 'scroll-write');
  const writesPostHide = overlayHiddenAt == null ? [] : writes.filter((w) => w.t >= overlayHiddenAt);

  const reversals = countReversals(post.map((s) => s.top));

  let lastChangeT = null;
  for (let i = 1; i < post.length; i++) {
    if (post[i].top !== post[i - 1].top) lastChangeT = post[i].t;
  }

  const finalTop = track.length ? track[track.length - 1].top : null;
  let peakTrackExcursionPx = null;
  if (finalTop != null && overlayHiddenAt != null) {
    let peak = 0;
    for (const s of track) {
      if (s.t < overlayHiddenAt) continue;
      peak = Math.max(peak, Math.abs(s.top - finalTop));
    }
    peakTrackExcursionPx = Math.round(peak);
  }

  return {
    overlayHiddenAt,
    finalWrapperTop: samples.length ? samples[samples.length - 1].top : null,
    writesPostHide: writesPostHide.length,
    writeReasonsPostHide: [...new Set(writesPostHide.map((w) => (w.reason || w.via || '?').toString()))],
    reversals,
    settleMs: overlayHiddenAt != null && lastChangeT != null ? Math.round(lastChangeT - overlayHiddenAt) : 0,
    peakTrackExcursionPx,
    events: (snap.events || []).map((e) => `${Math.round(e.t)}:${e.type}${e.persisted ? ':persisted' : ''}${e.state ? ':' + e.state : ''}`),
  };
}

/** Dump the forensics report as a test artifact on failure. Playwright
 *  afterEach signature: ({ page }, testInfo). */
/** Dump the forensics report to disk on failure. Playwright afterEach
 * signature: ({ page }, testInfo). Disk-not-attach: testInfo.attach output
 * did not survive this repo's reporter setup, so mirror the console-audit
 * pattern (navigation.fixture.js) — direct write under test-results/. */
export async function attachForensicsOnFailure({ page }, testInfo) {
  if (testInfo.status === testInfo.expectedStatus) return;
  if (!page || page.isClosed()) return;
  let snap = null;
  try {
    snap = await snapshotForensics(page);
  } catch (e) {
    console.warn(`[scroll-forensics] snapshot failed: ${String(e).split('\n')[0]}`);
  }
  try {
    mkdirSync(FORENSICS_DIR, { recursive: true });
    const name = testInfo.titlePath.join('__').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 180);
    writeFileSync(
      join(FORENSICS_DIR, `${name}.json`),
      JSON.stringify({ test: testInfo.titlePath.join(' > '), analysis: snap ? analyzeSettle(snap) : null, ...(snap || {}) }, null, 2)
    );
  } catch (e) {
    console.warn(`[scroll-forensics] dump failed: ${String(e).split('\n')[0]}`);
  }
}

/** Current wrapper scrollTop (null until the reader exists). */
export const readerScrollTop = (page) =>
  page.evaluate((s) => document.querySelector(s)?.scrollTop ?? null, SCROLLER);

/** Viewport-relative top of a node (px), or null if absent. */
export const nodeTop = (page, id) =>
  page.evaluate(({ nid, s }) => {
    const el = document.getElementById(nid);
    const root = document.querySelector(s);
    if (!el || !root) return null;
    return Math.round(el.getBoundingClientRect().top - root.getBoundingClientRect().top);
  }, { nid: id, s: SCROLLER });

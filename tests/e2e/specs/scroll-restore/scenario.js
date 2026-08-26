/**
 * Shared setup for specs/scroll-restore/: import a synthetic image book,
 * scroll to the deep marker, and wait for the reading position to save.
 *
 * Flow every spec builds on:
 *   1. attachScrollForensics (before any goto),
 *   2. image throttle registered in 'instant' mode from the start — every
 *      fulfill carries no-store, so LATER navigations always re-enter the
 *      route handler (a warm image cache would silently turn a 'hold' arm
 *      into an 'instant' one),
 *   3. import the generated book,
 *   4. find the SCROLLTARGET marker's node id by text, track it across
 *      navigations, scrollIntoView({block:'start'}), wait out the 250ms save
 *      throttle, and record what the saver captured.
 *
 * imageMode:
 *   'remote' (default) — `https://img.test/` refs, NO width/height attrs,
 *                        unsized maximal layout shift; import is a plain
 *                        markdown drop (fast).
 *   'media'            — dropped-with-the-md images served from
 *                        /<book>/media/...; dims may be stamped server-side.
 *   'none'             — no images at all (text-only control arm).
 */
import {
  generateImageBookMarkdown,
  importImageBook,
  importMarkdownBook,
  findNodeIdByText,
} from '../../helpers/bookContent.js';
import { makePng } from '../../helpers/pngGen.js';
import { throttleImages } from '../../helpers/mediaThrottle.js';
import {
  attachScrollForensics,
  trackNodeAcrossNavigations,
  readerScrollTop,
  nodeTop,
} from '../../helpers/scrollForensics.js';

const SCROLLER = '.reader-content-wrapper';
const REMOTE_PATTERN = 'https://img.test/**';
const MEDIA_PATTERN = '**/media/**';

/**
 * @returns {Promise<{
 *   bookId: string, markerId: string, savedElementId: string,
 *   savedScrollTop: number, throttle: Object,
 * }>}
 */
export async function setupImageBookScenario(page, spa, {
  imageMode = 'remote',
  imageWidth = 1400,
  imageHeight = 900,
} = {}) {
  await attachScrollForensics(page);

  const withImages = imageMode !== 'none';
  const { markdown, imageNames, markerText } = generateImageBookMarkdown({
    imageEvery: withImages ? 3 : Number.MAX_SAFE_INTEGER,
    imageMode,
  });

  const bytesByName = new Map(
    imageNames.map((n, i) => [
      n,
      makePng({
        width: imageWidth,
        height: imageHeight,
        rgb: [(196 + i * 13) % 256, (40 + i * 29) % 256, (90 + i * 47) % 256],
      }),
    ])
  );

  const throttle = await throttleImages(page, {
    pattern: imageMode === 'media' ? MEDIA_PATTERN : REMOTE_PATTERN,
    mode: 'instant',
    serve:
      imageMode === 'remote'
        ? (url) => bytesByName.get(url.split('/').pop()) ?? null
        : null,
  });

  const { bookId } =
    imageMode === 'media'
      ? await importImageBook(page, spa, {
          name: 'scroll-restore-images.md',
          markdown,
          images: bytesByName,
        })
      : await importMarkdownBook(page, spa, {
          name: 'scroll-restore-book.md',
          content: markdown,
        });

  await page.waitForSelector('.main-content p[id]', { timeout: 60_000 });
  await page.waitForTimeout(1200);

  // Only the first lazy chunk(s) render on landing — the marker lives deep.
  // Walk the wrapper down, letting the observer pull chunks into the DOM,
  // until the marker shows up (upstream chunks trim off behind us; harmless).
  let markerId = null;
  for (let i = 0; i < 40 && !markerId; i++) {
    markerId = await findNodeIdByText(page, markerText);
    if (markerId) break;
    await page.evaluate(() => {
      const el = document.querySelector('.reader-content-wrapper');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(700);
  }
  if (!markerId) {
    throw new Error(`marker paragraph not found in rendered book (needle: ${markerText})`);
  }
  await trackNodeAcrossNavigations(page, markerId);

  await page.evaluate((nid) => {
    document.getElementById(nid)?.scrollIntoView({ block: 'start' });
  }, markerId);
  await page.waitForTimeout(700); // outlast the 250ms scroll-save throttle

  const saved = await page.evaluate((bid) => {
    try {
      const raw = sessionStorage.getItem(`scrollPosition_${bid}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }, bookId);
  const savedElementId = saved?.elementId ?? null;
  const savedScrollTop = await readerScrollTop(page);
  if (savedElementId == null || savedScrollTop == null || savedScrollTop < 50) {
    throw new Error(
      `setup failed to save a deep position (elementId=${savedElementId}, scrollTop=${savedScrollTop})`
    );
  }

  // Normalize onto the plain READER url. Imports land on /book_X/edit, which
  // leaves THAT in history — and the editor's boot renders chunk 0 from the
  // top and never restores the saved chunk (the reader's restore machinery
  // doesn't own edit mode). A history entry pointing at /edit poisons every
  // back/forward arm; rewrite it via a real navigation to the read view, then
  // re-save the deep position there.
  await coldLoadBook(page, bookId);
  await waitForNode(page, markerId, 60_000);
  await page.waitForTimeout(1500);
  await page.evaluate((nid) => {
    document.getElementById(nid)?.scrollIntoView({ block: 'start' });
  }, markerId);
  await page.waitForTimeout(700);

  const saved2 = await page.evaluate((bid) => {
    try { return JSON.parse(sessionStorage.getItem(`scrollPosition_${bid}`) || 'null'); } catch { return null; }
  }, bookId);
  const savedScrollTop2 = await readerScrollTop(page);

  return {
    bookId,
    markerId,
    savedElementId: saved2?.elementId ?? savedElementId,
    savedScrollTop: savedScrollTop2 ?? savedScrollTop,
    throttle,
  };
}

export { readerScrollTop, nodeTop, SCROLLER };

/** The first `.chunk > [id]` node straddling the wrapper's top edge — the
 *  reader's CURRENT reading line. Stability assertions belong on THIS, not on
 *  an arbitrary tracked node: content growing between the fold and a node
 *  below it legitimately pushes that node down while the reading line holds. */
export function topVisibleProbe(page) {
  return page.evaluate(() => {
    const wrapper = document.querySelector('.reader-content-wrapper');
    if (!wrapper) return null;
    const top = wrapper.getBoundingClientRect().top;
    const nodes = [...wrapper.querySelectorAll('.chunk > [id]')];
    let lastAbove = null;
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.bottom > top + 1) {
        return { id: el.id, topOffset: Math.round(r.top - top) };
      }
      lastAbove = el;
    }
    return lastAbove ? { id: lastAbove.id, topOffset: Math.round(lastAbove.getBoundingClientRect().top - top) } : null;
  });
}

/** Wait for the boot overlay to be gone — forensics' "user can see it" line. */
export function waitForOverlayHidden(page, timeout = 30_000) {
  return page.waitForFunction(() => {
    const ov = document.getElementById('initial-navigation-overlay');
    if (!ov) return true;
    return getComputedStyle(ov).display === 'none';
  }, null, { timeout });
}

/** A genuine fresh document load of the book (home first, so no hash nav).
 *  The book goto waits only for DOMContentLoaded: 'load' never fires while
 *  an image-hold arm has media requests pending.
 *  Each goto retries ONCE on a host-level network blip (ERR_NETWORK_CHANGED —
 *  a Wi-Fi/VPN interface hop mid-run kills the navigation at the OS layer
 *  before the app is involved; one observed hit in an 18-minute run). */
async function gotoWithNetRetry(page, url, opts) {
  try {
    return await page.goto(url, opts);
  } catch (err) {
    if (!String(err?.message).includes('ERR_NETWORK_CHANGED')) throw err;
    await page.waitForTimeout(1500);
    return await page.goto(url, opts);
  }
}

export async function coldLoadBook(page, bookId) {
  await gotoWithNetRetry(page, '/');
  await page.waitForLoadState('networkidle');
  await gotoWithNetRetry(page, `/${bookId}`, { waitUntil: 'domcontentloaded' });
}

/** Wait for a node id to exist in the DOM (numeric ids don't selector-escape). */
export function waitForNode(page, nodeId, timeout = 30_000) {
  return page.waitForFunction((nid) => !!document.getElementById(nid), nodeId, { timeout });
}

/** Count of `.chunk` wrappers currently in the reader DOM. */
export const chunkCount = (page) =>
  page.evaluate(() => document.querySelectorAll('.main-content .chunk').length);

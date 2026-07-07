import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Reading-position SAVE system — direct coverage.
 *
 * The reader records "where am I" as you scroll: the topmost visible node's id
 * is written to sessionStorage (`scrollPosition_<bookId>`) + localStorage
 * (`scrollPosition_latest`) by the throttled scroll handler, and pushed to the
 * server (debounced 5s) for cross-device resume. This is the machinery in
 * lazyLoader/index.ts `forceSavePosition` + scrolling/readingPosition.ts.
 *
 * The audio player's start-position fix leans on this (it calls
 * `forceSaveScrollPosition()` right before choosing the first node), so this
 * spec pins the save behaviour on its own:
 *   A. the saved node id tracks the topmost visible node and advances as you
 *      scroll down; scrolling back to the top saves the first node again;
 *   B. `forceSaveScrollPosition()` writes the CURRENT node synchronously (no
 *      250ms throttle wait) — the exact hook the audio fix uses;
 *   C. the debounced server POST fires with the saved element_id + a chunk_id.
 *
 * Scroll container is .reader-content-wrapper. e2e is manual (npm run test:e2e).
 */

const SCROLLER = '.reader-content-wrapper';
const NODE_SEL = 'p[id],h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]';

/** Author a book long enough to scroll well below the fold, in read mode. */
async function buildScrollableBook(page, spa) {
  await page.setViewportSize({ width: 600, height: 500 });
  await spa.createNewBook(page, spa);

  await page.click('h1[id="100"]');
  await page.keyboard.type('Reading Position Save');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);

  for (let i = 0; i < 30; i++) {
    await page.keyboard.type(`Paragraph ${i} — filler content so the document overflows the viewport and there is real scroll room to move the saved reading position through.`);
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(300);

  // Leave edit mode → read mode (the reading-position save runs in the reader).
  await page.evaluate(() => document.getElementById('editButton')?.click());
  await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
}

/** Ordered numeric node ids currently rendered in the reader. */
function nodeIds(page) {
  return page.evaluate(({ scroller, sel }) => {
    const root = document.querySelector(scroller);
    if (!root) return [];
    return [...root.querySelectorAll(sel)]
      .map((e) => e.id)
      .filter((id) => /^\d+(\.\d+)?$/.test(id));
  }, { scroller: SCROLLER, sel: NODE_SEL });
}

/** The id the reading-position detector would pick RIGHT NOW — mirrors
 *  forceSavePosition: chunk children (any tag) with numeric ids, preferring
 *  the node whose box STRADDLES the container's top edge (the node actually
 *  being read), else the first node at/below the edge. */
function topVisibleId(page) {
  return page.evaluate(({ scroller, sel }) => {
    const root = document.querySelector(scroller);
    if (!root) return null;
    let els = [...root.querySelectorAll('.chunk > [id]')];
    if (els.length === 0) els = [...root.querySelectorAll(sel)];
    const top = root.getBoundingClientRect().top;
    let straddler = null;
    for (const el of els) {
      if (!/^\d+(\.\d+)?$/.test(el.id)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top >= top) {
        return (straddler && straddler.rect.bottom > top) ? straddler.el.id : el.id;
      }
      straddler = { el, rect };
    }
    return (straddler && straddler.rect.bottom > top) ? straddler.el.id : null;
  }, { scroller: SCROLLER, sel: NODE_SEL });
}

function savedElementId(page, bookId) {
  return page.evaluate((bid) => {
    try {
      const raw = sessionStorage.getItem(`scrollPosition_${bid}`);
      return raw ? (JSON.parse(raw).elementId ?? null) : null;
    } catch { return null; }
  }, bookId);
}

async function scrollNodeToTop(page, id) {
  await page.evaluate((nid) => {
    document.getElementById(nid)?.scrollIntoView({ block: 'start' });
  }, id);
  await page.waitForTimeout(500); // outlast the 250ms scroll-save throttle
}

test.describe('reading position save', () => {
  test('saved node id tracks the reader position, updates on scroll, and persists', async ({ page, spa }) => {
    test.setTimeout(120_000);

    await buildScrollableBook(page, spa);
    const bookId = await spa.getCurrentBookId(page);

    const ids = await nodeIds(page);
    expect(ids.length, 'precondition: book has many nodes to scroll through').toBeGreaterThan(10);
    const firstId = ids[0];
    const midId = ids[Math.floor(ids.length / 2)];
    const deepId = ids[ids.length - 3];

    // ── A. tracks the topmost visible node + advances as you scroll ──
    await scrollNodeToTop(page, firstId);
    const savedTop = await savedElementId(page, bookId);
    expect(savedTop, 'at the top, the saved node is the first node').toBe(firstId);

    await scrollNodeToTop(page, midId);
    const savedMid = await savedElementId(page, bookId);
    const expectedMid = await topVisibleId(page);
    // Saved value equals the live detector's pick AND moved down the document.
    expect(savedMid).toBe(expectedMid);
    expect(parseFloat(savedMid), 'saved node advanced past the first node').toBeGreaterThan(parseFloat(firstId));

    await scrollNodeToTop(page, deepId);
    const savedDeep = await savedElementId(page, bookId);
    expect(parseFloat(savedDeep), 'saved node advanced further on deeper scroll').toBeGreaterThan(parseFloat(savedMid));

    // localStorage mirrors sessionStorage (the cross-tab / latest fallback).
    const latest = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('scrollPosition_latest') || '{}').elementId ?? null; } catch { return null; }
    });
    expect(latest, 'scrollPosition_latest mirrors the current saved node').toBe(savedDeep);

    // ── B. getFreshAnchor() captures the current node SYNCHRONOUSLY ──
    await scrollNodeToTop(page, firstId);
    expect(await savedElementId(page, bookId)).toBe(firstId);

    // Scroll deep, then read the FRESH anchor WITHOUT waiting out the throttle
    // — this is the accessor every "act on current position" feature uses
    // (audio start, search open, caret placement, TOC bookmark).
    await page.evaluate((nid) => {
      document.getElementById(nid)?.scrollIntoView({ block: 'start' });
    }, deepId);
    const freshAnchor = await page.evaluate(async (bid) => {
      // Vetted raw-vite direct-invoke pattern (see a11y/modal-surfaces.spec.js).
      const mod = await import(`${location.origin}/resources/js/scrolling/readingAnchor.ts`);
      return mod.getFreshAnchor(bid)?.elementId ?? null;
    }, bookId);
    expect(
      parseFloat(freshAnchor),
      'getFreshAnchor() synchronously captured the deep position (no throttle wait)'
    ).toBeGreaterThan(parseFloat(firstId));
    // And the fresh save landed in storage too (same value both ways).
    expect(await savedElementId(page, bookId)).toBe(freshAnchor);

    // ── C. debounced server POST carries element_id + chunk_id ──
    const posts = [];
    await page.route('**/api/database-to-indexeddb/books/*/reading-position', async (route) => {
      try { posts.push(route.request().postDataJSON()); } catch { posts.push(null); }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });

    await scrollNodeToTop(page, midId);
    const savedForServer = await savedElementId(page, bookId);
    // debouncedServerSave waits 5s — give it margin.
    await page.waitForTimeout(6500);

    expect(posts.length, 'a debounced reading-position POST fired').toBeGreaterThan(0);
    const last = posts[posts.length - 1];
    expect(last, 'POST body is JSON').toBeTruthy();
    expect(last.element_id, 'POST element_id matches the saved node').toBe(savedForServer);
    expect(last.chunk_id, 'POST includes a chunk_id').not.toBeUndefined();
  });
});

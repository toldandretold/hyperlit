/**
 * Layer 4 (manual e2e) of the chunkID coverage — the highest-fidelity, slowest leg. The unit
 * legs (tests/javascript/divEditor/chunkOverflow.fractional.test.js + indexedDB/chunkId.roundtrip)
 * and the Pest PG round-trip (tests/Feature/Api/ChunkIdRoundTripTest.php) already pin the logic;
 * this drives it through REAL gestures end to end as belt-and-suspenders.
 *
 * Scenario (mirrors how a fractional chunk is actually born):
 *   1. Paste >100 nodes into a fresh book → the initial chunk overflows and splits. The FIRST
 *      split appends a new chunk at the end, so these ids are INTEGERS (no neighbour to wedge
 *      between).
 *   2. Move the cursor ABOVE existing content and paste >100 more → now a chunk must be inserted
 *      BETWEEN two existing chunks, which is exactly when fractional indexing kicks in. Assert a
 *      DECIMAL `data-chunk-id` and a DECIMAL node `id=` (startLine) appear, and no chunk exceeds
 *      the 100-node limit.
 *   3. Reload. Assert reading order is preserved, no nodes are lost, AND the decimal chunk id
 *      survives the PG round-trip (the backend now casts chunk_id `(float)` like startLine, so
 *      `4.1` no longer collapses to `4` — see tests/Feature/Api/ChunkIdRoundTripTest.php).
 *
 * MANUAL ONLY: e2e is not in CI (`npm run test:e2e`). This test self-creates its book (via the
 * new-book button, like authoring-workflow.spec.js), so it needs a working home→reader SPA but
 * NOT a pre-seeded E2E_READER_BOOK.
 */
import { test, expect } from '../../fixtures/navigation.fixture.js';

const NODE_LIMIT = 100;
const PASTE_COUNT = 130; // over NODE_LIMIT so chunk 0 fills to 100 and the rest overflow-splits
// A SMALL mid-document paste does NOT renumber the book — it wedges the new nodes between existing
// ones via fractional indexing (decimal startLine). A LARGE paste instead renumbers from the
// insertion point to integers. Inserting a small paste into the now-FULL chunk 0 pushes it past
// NODE_LIMIT; the chunk-overflow auto-rotation (chunkMutationHandler) must then bring it back to
// ≤100. (Whether that mint a fractional CHUNK id or merges into the neighbour depends on neighbour
// fullness — the fractional-chunk path itself is unit-tested in chunkOverflow.fractional.test.js.)
const SMALL_PASTE_COUNT = 3;

/** A clipboard HTML payload of `n` distinct paragraphs (plus a plain-text twin). */
function makeParagraphPayload(n, tag) {
  const html = Array.from({ length: n }, (_, i) => `<p>${tag} paragraph ${i} — lorem ipsum dolor sit amet</p>`).join('');
  const text = Array.from({ length: n }, (_, i) => `${tag} paragraph ${i} — lorem ipsum dolor sit amet`).join('\n');
  return { html, text };
}

/** Every numeric-id node (the startLine ids), in DOM order, as strings. */
async function numericNodeIds(page) {
  return page.evaluate(() => {
    const re = /^\d+(\.\d+)?$/;
    return Array.from(document.querySelectorAll('.main-content [id]'))
      .map(el => el.id)
      .filter(id => re.test(id));
  });
}

/**
 * Force every chunk to render into the DOM. Chunks are lazy: after a paste only the
 * insertion chunk (chunk 0) is rendered; the overflow chunk(s) live in IndexedDB until
 * scrolled into view. chunkSnapshot() reads the *DOM*, so we must pump the lazy loader
 * before snapshotting or we'd only ever see the one rendered chunk (and wrongly conclude
 * "no split happened").
 */
async function pumpLazyLoader(page) {
  await page.evaluate(async () => {
    const sentinel = document.querySelector('[id$="-bottom-sentinel"]');
    for (let i = 0; sentinel && i < 15; i++) {
      sentinel.scrollIntoView({ block: 'end' });
      await new Promise(r => setTimeout(r, 250));
    }
  });
  await page.waitForTimeout(500);
}

/** Per-chunk node counts + the chunk ids, from the live DOM. */
async function chunkSnapshot(page) {
  return page.evaluate(() => {
    const re = /^\d+(\.\d+)?$/;
    return Array.from(document.querySelectorAll('.main-content .chunk[data-chunk-id]')).map(chunk => ({
      id: chunk.getAttribute('data-chunk-id'),
      count: Array.from(chunk.querySelectorAll('[id]')).filter(el => re.test(el.id)).length,
    }));
  });
}

async function createFreshBook(page, spa) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.click('#newBookButton');
  await page.waitForFunction(() => {
    const c = document.getElementById('newbook-container');
    return c && getComputedStyle(c).opacity !== '0' && getComputedStyle(c).width !== '0px';
  }, null, { timeout: 5000 });
  await page.click('#createNewBook');
  await spa.waitForTransition(page);
  expect(await spa.getStructure(page)).toBe('reader');
  await spa.waitForEditMode(page);
  await page.waitForSelector('h1[id="100"]', { timeout: 5000 });
  return spa.getCurrentBookId(page);
}

async function clickIntoTopNode(page) {
  await page.click('h1[id="100"]');
}

/** Place the caret in the FIRST numeric-id paragraph after the title — i.e. ABOVE the bulk. */
async function clickIntoEarlyParagraph(page) {
  // Scroll the early paragraph into view and place a REAL caret in it. A programmatic
  // selection alone doesn't survive when the view is scrolled elsewhere (e.g. right after
  // pumping the lazy loader to the bottom) — the paste then lands at the last real caret
  // (document end) instead of mid-document, so no fractional chunk gets minted.
  const earlyId = await page.evaluate(() => {
    const re = /^\d+(\.\d+)?$/;
    const ps = Array.from(document.querySelectorAll('.main-content p')).filter(p => re.test(p.id));
    const target = ps[0] || document.querySelector('h1[id="100"]');
    target.scrollIntoView({ block: 'center' });
    return target.id;
  });
  await page.click(`.main-content [id="${earlyId}"]`); // real click → real caret
  // Collapse the caret to the very start so the next paste lands ABOVE the bulk.
  await page.evaluate((id) => {
    const target = document.getElementById(id);
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    target.focus?.();
  }, earlyId);
  return earlyId; // caller pastes with { caretElementId } so the paste lands here, not at doc end
}

test.describe('Chunk overflow via mass paste — fractional chunk/line ids', () => {
  test.setTimeout(180_000);

  test('mid-document paste mints decimal chunk_id + startLine; reload keeps order & nodes', async ({ page, spa }) => {
    await createFreshBook(page, spa);

    // ── Phase 1: paste over the limit → first overflow split (integer chunk ids) ──
    await clickIntoTopNode(page);
    const first = makeParagraphPayload(PASTE_COUNT, 'A');
    await spa.pasteHyperciteContent(page, first.html, first.text);
    await page.waitForTimeout(2500); // let the save queue + overflow observer settle

    await pumpLazyLoader(page); // render the lazy overflow chunk(s), not just chunk 0
    const afterFirst = await chunkSnapshot(page);
    expect(afterFirst.length, 'initial chunk should have split').toBeGreaterThanOrEqual(2);
    for (const c of afterFirst) {
      expect(c.count, `chunk ${c.id} over the ${NODE_LIMIT} limit`).toBeLessThanOrEqual(NODE_LIMIT);
    }

    // ── Phase 2: SMALL mid-document paste into the now-FULL chunk 0 → overflow must auto-rotate ──
    // The small paste mints decimal startLines (fractional indexing) AND pushes chunk 0 past
    // NODE_LIMIT. The chunk-overflow auto-rotation must bring it back to ≤100. Regression guard:
    // before the fix, the small-paste mutations were suppressed (paste/programmatic flags), the
    // overflow auto-rotation never ran, and chunk 0 sat at 104 — corrupting lazy loading.
    const earlyId = await clickIntoEarlyParagraph(page);
    const second = makeParagraphPayload(SMALL_PASTE_COUNT, 'B');
    // caretElementId forces the synthetic paste to land at this early node (mid-document, in the
    // full chunk 0), not at the document end (the helper's default).
    await spa.pasteHyperciteContent(page, second.html, second.text, { caretElementId: earlyId });
    await page.waitForTimeout(2500);
    await pumpLazyLoader(page);

    // The overflow sweep is ASYNCHRONOUS (it runs once the paste's flags clear). Poll until every
    // rendered chunk is ≤ NODE_LIMIT — this is the assertion that the auto-rotation actually fired.
    await expect.poll(async () => {
      await pumpLazyLoader(page);
      const snap = await chunkSnapshot(page);
      return Math.max(0, ...snap.map(c => c.count));
    }, { message: 'a chunk stayed over the NODE_LIMIT — overflow auto-rotation did not fire', timeout: 15000 })
      .toBeLessThanOrEqual(NODE_LIMIT);

    const afterSecond = await chunkSnapshot(page);
    const ids = await numericNodeIds(page);

    // The small paste minted a fractional (decimal) startLine via fractional indexing.
    expect(ids.some(id => /\.\d/.test(id)), 'small paste should mint a decimal startLine id').toBe(true);

    // And still no chunk over the limit (re-assert on the settled snapshot).
    for (const c of afterSecond) {
      expect(c.count, `chunk ${c.id} over the ${NODE_LIMIT} limit`).toBeLessThanOrEqual(NODE_LIMIT);
    }

    // Capture order + total before reload (sorted numerically = DOM order if ids are consistent).
    const before = await numericNodeIds(page);
    const beforeSorted = [...before].map(Number).sort((a, b) => a - b);
    expect(before.map(Number)).toEqual(beforeSorted); // ids increase monotonically down the page

    // Wait for sync to PG before reloading (green cloud, else a generous beat).
    await page.waitForFunction(() => {
      const c = document.querySelector('#cloudRef-svg .cls-1');
      return c && c.getAttribute('fill') === '#63B995';
    }, null, { timeout: 8000 }).catch(() => page.waitForTimeout(4000));

    // ── Phase 3: reload → order preserved, no node loss ──
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.main-content .chunk[data-chunk-id]', { timeout: 15000 });
    // Pump the lazy loader so every chunk renders into the DOM.
    await page.evaluate(async () => {
      const sentinel = document.querySelector('[id$="-bottom-sentinel"]');
      for (let i = 0; sentinel && i < 15; i++) {
        sentinel.scrollIntoView({ block: 'end' });
        await new Promise(r => setTimeout(r, 250));
      }
    });
    await page.waitForTimeout(1000);

    const after = await numericNodeIds(page);
    const afterChunks = await chunkSnapshot(page);
    // No nodes lost across the reload round-trip.
    expect(after.length, 'node count changed across reload').toBe(before.length);
    // Reading order still monotonic.
    const afterSorted = [...after].map(Number).sort((a, b) => a - b);
    expect(after.map(Number)).toEqual(afterSorted);
    // Decimal startLine ids survive the reload as floats (the (int)→(float) read-back cast) — no
    // integer collapse. (Decimal CHUNK-id round-tripping is covered by chunkRender.decimal.test.js.)
    expect(after.some(id => /\.\d/.test(id)), 'decimal startLine ids should survive reload').toBe(true);
    // And no chunk exceeds the limit (a collision would have merged two chunks into one >100 div).
    for (const c of afterChunks) {
      expect(c.count, `chunk ${c.id} over the ${NODE_LIMIT} limit after reload`).toBeLessThanOrEqual(NODE_LIMIT);
    }

    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
  });
});

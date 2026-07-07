import { test, expect } from '../../fixtures/navigation.fixture.js';

/**
 * Audio player START POSITION — regression for "Listen jumps to the top".
 *
 * Bug: scrolled deep into a book that already has audio, pressing Listen in the
 * settings menu scrolled the reader all the way back to the top and started
 * narrating from the first node — instead of the paragraph in view.
 *
 * Cause: playbackController.findStartIndex() relied on a brittle viewportAnchor()
 * (a divergent current-node detector) and, when it returned null, fell through a
 * stale sessionStorage anchor to `return 0` (book top). Fix: start() now calls
 * the reading-position system's proven `forceSaveScrollPosition()` synchronously
 * before choosing the start node, and findStartIndex() trusts that fresh anchor.
 *
 * Real TTS is external/expensive and there's no audio fixture, so the manifest
 * is mocked and <audio>.play() is stubbed — what we assert is the START-NODE
 * choice (the `audio-reading` highlight), not real MP3 playback. e2e is manual.
 */

const SCROLLER = '.reader-content-wrapper';
const NODE_SEL = 'p[id],h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]';
const READING_CLASS = 'audio-reading';

async function buildScrollableBook(page, spa) {
  await page.setViewportSize({ width: 600, height: 500 });
  await spa.createNewBook(page, spa);

  await page.click('h1[id="100"]');
  await page.keyboard.type('Audio Start Position');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);

  for (let i = 0; i < 30; i++) {
    await page.keyboard.type(`Paragraph ${i} — filler so the book overflows the viewport and the Listen press happens well below the fold.`);
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(300);

  await page.evaluate(() => document.getElementById('editButton')?.click());
  await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
}

function nodeIds(page) {
  return page.evaluate(({ scroller, sel }) => {
    const root = document.querySelector(scroller);
    if (!root) return [];
    return [...root.querySelectorAll(sel)].map((e) => e.id).filter((id) => /^\d+(\.\d+)?$/.test(id));
  }, { scroller: SCROLLER, sel: NODE_SEL });
}

function readerScrollTop(page) {
  return page.evaluate((scroller) => {
    const el = document.querySelector(scroller);
    return el ? el.scrollTop : null;
  }, SCROLLER);
}

function savedElementId(page, bookId) {
  return page.evaluate((bid) => {
    try {
      const raw = sessionStorage.getItem(`scrollPosition_${bid}`);
      return raw ? (JSON.parse(raw).elementId ?? null) : null;
    } catch { return null; }
  }, bookId);
}

test.describe('audio start position', () => {
  test('Listen starts at the current reading position, not the top of the book', async ({ page, spa }) => {
    test.setTimeout(120_000);

    await buildScrollableBook(page, spa);
    const bookId = await spa.getCurrentBookId(page);

    const ids = await nodeIds(page);
    expect(ids.length, 'precondition: many nodes').toBeGreaterThan(10);
    const firstId = ids[0];
    const deepId = ids[ids.length - 3];

    // ── Scroll a deep node to the top and let the reading position save ──
    await page.evaluate((nid) => document.getElementById(nid)?.scrollIntoView({ block: 'start' }), deepId);
    await page.waitForTimeout(500); // outlast the 250ms save throttle
    const savedDeep = await savedElementId(page, bookId);
    expect(parseFloat(savedDeep), 'precondition: reading position saved deep in the book').toBeGreaterThan(parseFloat(firstId));
    const scrollBeforePlay = await readerScrollTop(page);
    expect(scrollBeforePlay, 'precondition: reader is scrolled down').toBeGreaterThan(50);

    // ── Mock the audio manifest to cover every node (all fresh) ──
    const manifestNodes = await page.evaluate((scroller) => {
      const root = document.querySelector(scroller);
      const out = {};
      root.querySelectorAll('[data-node-id]').forEach((el) => {
        const nid = el.getAttribute('data-node-id');
        if (nid) out[nid] = { filename: 'stub.mp3', duration_ms: 1000, stale: false };
      });
      return out;
    }, SCROLLER);
    expect(Object.keys(manifestNodes).length, 'nodes have data-node-id for the manifest').toBeGreaterThan(10);

    await page.route('**/api/book-audio/*/manifest', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ voice: null, nodes: manifestNodes }),
      });
    });

    // Stub <audio>.play() so a missing MP3 file (404) can't throw → skip-ahead
    // past our target node. The gesture is real; only the media element is fake.
    await page.evaluate(() => {
      // eslint-disable-next-line no-undef
      HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
    });

    // ── Press Listen (document-delegated handler → openAudioPlayer) ──
    await page.evaluate(() => document.getElementById('audioListenButton')?.click());

    // Playback highlights the start node with READING_CLASS once it begins.
    await page.waitForSelector(`.${READING_CLASS}`, { timeout: 10_000 });
    await page.waitForTimeout(400);

    const readingId = await page.evaluate((cls) => {
      const el = document.querySelector(`.${cls}`);
      return el ? el.id : null;
    }, READING_CLASS);

    // ── The fix: start node is the reader's saved position, NOT the top ──
    expect(readingId, 'a node is highlighted as the reading start node').toBeTruthy();
    expect(readingId, 'playback did NOT snap to the first node').not.toBe(firstId);
    expect(readingId, 'playback started at the saved reading position').toBe(savedDeep);

    const scrollAfterPlay = await readerScrollTop(page);
    expect(
      scrollAfterPlay,
      `reader did NOT jump to the top on play (before=${scrollBeforePlay}, after=${scrollAfterPlay})`
    ).toBeGreaterThan(50);
  });
});

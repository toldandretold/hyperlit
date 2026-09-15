import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  authorAudioBook, routeAudioManifest, routeAudioFiles, unrouteAudio,
  startListening, getTrace, waitForNodesStarted, attachTraceOnFailure,
  SCROLLER, AUDIO_LAUNCH_ARGS,
} from '../../helpers/audioHarness.js';

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
 * HARNESS. This spec used to stub HTMLMediaElement.play() and point every node
 * at a 404ing stub.mp3 — but the 404 fired a real media `error`, so
 * recoverFrom() retried (600ms) and then SKIPPED to the next node, and the
 * assertion raced that skip cascade (flaked as start+1, e.g. 2900 vs 2800).
 * Now it serves the real silent MP3 per node (helpers/audioHarness.js) and
 * asserts the START choice off the trace's FIRST `node-start`, which cannot be
 * perturbed by playback advancing afterwards.
 */

const NODE_SEL = 'p[id],h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]';

// serviceWorkers 'block': public/sw.js proxies non-/api/ GETs through its own
// fetch(), and a service-worker fetch is invisible to page.route — so an MP3
// route would silently never fire and every node would 404 from the real
// server (the exact skip cascade this rewrite removes).
test.use({
  serviceWorkers: 'block',
  // AUDIO_LAUNCH_ARGS also blocks host media events (media keys, AirPods,
  // screen lock) from pausing the run through the mediaSession handler.
  launchOptions: { args: AUDIO_LAUNCH_ARGS },
});

test.afterEach(async ({ page }, testInfo) => {
  await attachTraceOnFailure(page, testInfo);
  await unrouteAudio(page);
});

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

/** data-node-id of a node element, looked up by its DOM id (startLine). */
function dataNodeIdOf(page, elementId) {
  return page.evaluate((eid) => document.getElementById(eid)?.getAttribute('data-node-id') ?? null, elementId);
}

test.describe('audio start position', () => {
  test('Listen starts at the current reading position, not the top of the book', async ({ page, spa }) => {
    // scrollTop-based precondition ("reader is scrolled down") — the wrapper
    // never scrolls in paginated mode. The start-at-current-position invariant
    // itself is mode-independent (getFreshAnchor has a paginated branch) and
    // stays covered by normal runs + the paginator browser smoke.
    test.skip(process.env.E2E_READING_MODE === 'paginated', 'asserts scroll-mode scrollTop mechanics');
    test.setTimeout(120_000);

    await page.setViewportSize({ width: 600, height: 500 });
    const { bookId } = await authorAudioBook(page, spa, {
      paragraphs: 30, title: 'Audio Start Position',
    });

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

    // The trace records nodeIds (data-node-id); the anchor is a DOM id.
    const savedNodeId = await dataNodeIdOf(page, savedDeep);
    const firstNodeId = await dataNodeIdOf(page, firstId);
    expect(savedNodeId, 'saved anchor node has a data-node-id').toBeTruthy();

    // ── Real audio: manifest covers every node, each served a real MP3 ──
    const order = await routeAudioManifest(page);
    expect(order.length, 'nodes have data-node-id for the manifest').toBeGreaterThan(10);
    await routeAudioFiles(page);

    // ── Press Listen (document-delegated handler → openAudioPlayer) ──
    await startListening(page);
    await waitForNodesStarted(page, 1);

    // ── The fix: the FIRST node started is the reader's position, not the top.
    // Asserted off the trace, not the live highlight — real playback advances
    // (and used to skip on 404s), so "what is highlighted right now" races.
    const trace = await getTrace(page);
    const firstStart = trace.find((e) => e.event === 'node-start');
    expect(firstStart, 'playback traced a start node').toBeTruthy();
    expect(firstStart.nodeId, 'playback did NOT snap to the first node').not.toBe(firstNodeId);
    expect(firstStart.nodeId, 'playback started at the saved reading position').toBe(savedNodeId);

    const scrollAfterPlay = await readerScrollTop(page);
    expect(
      scrollAfterPlay,
      `reader did NOT jump to the top on play (before=${scrollBeforePlay}, after=${scrollAfterPlay})`
    ).toBeGreaterThan(50);
  });
});

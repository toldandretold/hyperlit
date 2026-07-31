import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  authorAudioBook, routeAudioManifest, routeAudioFiles, unrouteAudio,
  startListening, getTrace, waitForNodesStarted, waitForTraceEvent,
  waitForPlaybackToReachEnd, playlistTotal, startedIndices, traceEvents,
  attachTraceOnFailure, PILL,
} from '../../helpers/audioHarness.js';

/**
 * Audio STALL RECOVERY — "it sometimes randomly stops and I have to press
 * back/forward to get it going again".
 *
 * The engine used to listen for `ended` and nothing else, so any paragraph whose
 * download broke, 500'd or simply hung left the player silent with the pill
 * still claiming to play. Each test here injects one of those faults into a real
 * MP3 stream (helpers/audioHarness.js) and asserts the player RECOVERS rather
 * than freezing: retry the paragraph once, then skip, and a watchdog for the
 * shapes that produce no event at all.
 *
 * The unit suite (tests/javascript/audioPlayer/stallRecovery.test.js) covers the
 * same causes deterministically; this is the does-it-hold-in-Chromium layer.
 */

// serviceWorkers 'block': public/sw.js proxies non-/api/ GETs through its own
// fetch(), and a service-worker fetch is invisible to page.route — so the MP3
// routes below silently never fired and every paragraph 404'd from the real
// server. Blocking it also keeps these specs off the SW's stale-JS cache.
test.use({
  serviceWorkers: 'block',
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
});

test.afterEach(async ({ page }, testInfo) => {
  await attachTraceOnFailure(page, testInfo);
  await unrouteAudio(page);
});

test.describe('audio stall recovery', () => {
  test('a paragraph whose download drops once is retried, not lost', async ({ page, spa }) => {
    test.setTimeout(180_000);

    await page.setViewportSize({ width: 900, height: 700 });
    await authorAudioBook(page, spa, { paragraphs: 6, title: 'Transient Drop' });
    await routeAudioManifest(page);
    const requested = await routeAudioFiles(page, {
      failures: { 'n2.mp3': { mode: 'abort', once: true } },
    });

    await startListening(page);
    await waitForNodesStarted(page, 1);
    const total = await playlistTotal(page);

    await waitForPlaybackToReachEnd(page, total);

    const trace = await getTrace(page);
    expect(traceEvents(trace, 'retry').length, 'the dropped paragraph was retried').toBeGreaterThanOrEqual(1);
    expect(traceEvents(trace, 'skip'), 'and NOT skipped — the audio was fine').toHaveLength(0);
    expect(requested.filter((n) => n === 'n2.mp3').length,
      'the media element fetched the file again for the retry').toBeGreaterThanOrEqual(2);

    const indices = startedIndices(trace);
    expect(indices.at(-1), 'playback still reached the final paragraph').toBe(total - 1);
    expect(indices, 'and skipped nothing on the way').toEqual(
      Array.from({ length: indices.length }, (_, i) => indices[0] + i),
    );
    await expect(page.locator(PILL)).toHaveClass(/visible/);
  });

  test('a permanently broken paragraph degrades to a skip, never a freeze', async ({ page, spa }) => {
    test.setTimeout(180_000);

    await page.setViewportSize({ width: 900, height: 700 });
    await authorAudioBook(page, spa, { paragraphs: 6, title: 'Permanent Failure' });
    await routeAudioManifest(page);
    await routeAudioFiles(page, {
      failures: { 'n3.mp3': { mode: 'server' } }, // 500s every single time
    });

    await startListening(page);
    await waitForNodesStarted(page, 1);
    const total = await playlistTotal(page);

    // The broken paragraph still gets a node-start (it's traced before the
    // load), so playback walks to the end even though one can't play.
    await waitForPlaybackToReachEnd(page, total);

    const trace = await getTrace(page);
    expect(traceEvents(trace, 'retry').length, 'it tried once more first').toBeGreaterThanOrEqual(1);
    expect(traceEvents(trace, 'skip').length, 'then gave up on that paragraph').toBeGreaterThanOrEqual(1);
    expect(traceEvents(trace, 'skip').length, 'and did not cascade through the book').toBeLessThanOrEqual(2);

    // The point: the rest of the book still played, right to the last paragraph.
    const lastStart = traceEvents(trace, 'node-start').at(-1);
    expect(lastStart.index, 'playback continued past the broken paragraph').toBe(total - 1);
  });

  test('the watchdog rescues a download that hangs forever', async ({ page, spa }) => {
    test.setTimeout(180_000);

    await page.setViewportSize({ width: 900, height: 700 });
    await authorAudioBook(page, spa, { paragraphs: 5, title: 'Hung Download' });
    await routeAudioManifest(page);
    await routeAudioFiles(page, {
      failures: { 'n2.mp3': { mode: 'hang' } }, // the request never settles
    });

    await startListening(page);
    await waitForNodesStarted(page, 3); // reach the hanging paragraph

    // Nothing else will ever fire for this node — no ended, no error. The
    // watchdog is the only thing that can notice.
    await waitForTraceEvent(page, 'watchdog', 60_000);

    await waitForNodesStarted(page, 4, 60_000);

    const trace = await getTrace(page);
    const lastStart = traceEvents(trace, 'node-start').at(-1);
    expect(lastStart.index, 'playback moved past the hung paragraph').toBeGreaterThanOrEqual(3);
    await expect(page.locator(PILL), 'the pill never disappeared on the user').toHaveClass(/visible/);
  });

  test('stopping deliberately is not mistaken for a stall', async ({ page, spa }) => {
    test.setTimeout(180_000);

    await page.setViewportSize({ width: 900, height: 700 });
    await authorAudioBook(page, spa, { paragraphs: 5, title: 'Clean Stop' });
    await routeAudioManifest(page);
    await routeAudioFiles(page);

    await startListening(page);
    await waitForNodesStarted(page, 2);

    await page.click('#audio-stop');
    await page.waitForTimeout(2000);

    const trace = await getTrace(page);
    const afterStop = trace.slice(trace.findIndex((e) => e.event === 'stop'));
    expect(traceEvents(afterStop, 'retry'), 'teardown did not trigger a recovery').toHaveLength(0);
    expect(traceEvents(afterStop, 'watchdog'), 'the watchdog stopped with playback').toHaveLength(0);
    expect(traceEvents(afterStop, 'node-start'), 'nothing restarted itself').toHaveLength(0);

    await expect(page.locator(PILL)).not.toHaveClass(/visible/);
    expect(page.pageErrors).toHaveLength(0);
  });
});

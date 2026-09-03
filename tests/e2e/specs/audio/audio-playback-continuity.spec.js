import { test, expect } from '../../fixtures/navigation.fixture.js';
import {
  authorAudioBook, routeAudioManifest, routeAudioFiles, unrouteAudio,
  startListening, getTrace, waitForNodesStarted, waitForPlaybackToReachEnd,
  playlistTotal, startedIndices, traceEvents,
  attachTraceOnFailure, PILL, AUDIO_LAUNCH_ARGS,
} from '../../helpers/audioHarness.js';

/**
 * Audio playback CONTINUITY — the two reported bugs, in a real browser.
 *
 * 1. "I set 1.5×, it works, then the next paragraph is back to normal speed but
 *    the UI still shows 1.5×." Assigning `.src` runs the media load algorithm,
 *    which resets playbackRate to defaultPlaybackRate — never set, so 1. The
 *    speed survived exactly one paragraph.
 * 2. "It sometimes randomly stops and I have to press back/forward." The engine
 *    listened for `ended` and nothing else.
 *
 * Unlike audio-start-position.spec.js, these serve a REAL tiny MP3 per paragraph
 * (helpers/audioHarness.js) so `ended` genuinely fires and playback genuinely
 * advances — a stubbed play() cannot exercise either bug. The <audio> element is
 * detached, so assertions read `window.__audioTrace` (audioTrace.ts).
 */

// autoplay-policy: playback starts on a real click, but that activation ages
// across the awaits and the recovery backoff, so post-`ended` advances would
// otherwise be policy-dependent and flaky. Per-file, so every other spec keeps
// honest autoplay semantics.
// serviceWorkers 'block': public/sw.js proxies non-/api/ GETs through its own
// fetch(), and a service-worker fetch is invisible to page.route — so the MP3
// routes below silently never fired and every paragraph 404'd from the real
// server. Blocking it also keeps these specs off the SW's stale-JS cache.
test.use({
  serviceWorkers: 'block',
  // AUDIO_LAUNCH_ARGS also disables Chrome's hardware-media-key / media-session
  // integration: a host media event (media key, AirPods hand-off, screen lock)
  // once paused a run mid-book through the engine's mediaSession handler with
  // nothing in the trace (2026-09-03 stall at 5/10). See audioHarness.js.
  launchOptions: { args: AUDIO_LAUNCH_ARGS },
});

test.afterEach(async ({ page }, testInfo) => {
  await attachTraceOnFailure(page, testInfo);
  await unrouteAudio(page);
});

test.describe('audio playback continuity', () => {
  test('a chosen speed survives every paragraph boundary', async ({ page, spa }) => {
    test.setTimeout(180_000);

    await page.setViewportSize({ width: 900, height: 700 });
    await authorAudioBook(page, spa, { paragraphs: 6, title: 'Speed Continuity' });
    await routeAudioManifest(page);
    await routeAudioFiles(page);

    await startListening(page);
    await waitForNodesStarted(page, 1);

    // 1 → 1.25 → 1.5
    await page.click('#audio-speed');
    await page.click('#audio-speed');
    await expect(page.locator('#audio-speed')).toHaveText('1.5×');

    await waitForNodesStarted(page, 4);

    const trace = await getTrace(page);
    const speedAt = trace.findIndex((e) => e.event === 'speed');
    expect(speedAt, 'the speed change is in the trace').toBeGreaterThanOrEqual(0);

    const playingAfter = traceEvents(trace.slice(speedAt), 'playing');
    expect(playingAfter.length, 'playback continued past the speed change').toBeGreaterThanOrEqual(2);

    const rates = [...new Set(playingAfter.map((e) => e.playbackRate))];
    expect(rates, `every paragraph after the change played at 1.5× (saw ${rates.join(', ')})`).toEqual([1.5]);

    // ...and the pill still agrees with the engine.
    await expect(page.locator('#audio-speed')).toHaveText('1.5×');
  });

  test('plays straight through a book without stalling', async ({ page, spa }) => {
    test.setTimeout(180_000);

    await page.setViewportSize({ width: 900, height: 700 });
    await authorAudioBook(page, spa, { paragraphs: 8, title: 'Continuous Playback' });
    await routeAudioManifest(page);
    const requested = await routeAudioFiles(page);

    await startListening(page);
    await waitForNodesStarted(page, 1);
    const total = await playlistTotal(page);
    expect(total, 'the player queued a real playlist').toBeGreaterThan(4);

    await waitForPlaybackToReachEnd(page, total);

    const trace = await getTrace(page);
    expect(traceEvents(trace, 'skip'), 'nothing was skipped').toHaveLength(0);
    expect(traceEvents(trace, 'retry'), 'nothing needed a retry').toHaveLength(0);
    expect(traceEvents(trace, 'watchdog'), 'the watchdog never had to intervene').toHaveLength(0);
    expect(traceEvents(trace, 'error'), 'no media errors').toHaveLength(0);

    // Playback starts at the reader's position, so it need not begin at 0 — but
    // from wherever it starts it must walk every index, in order, to the end.
    const indices = startedIndices(trace);
    expect(indices.at(-1), 'it reached the final paragraph').toBe(total - 1);
    expect(indices.length, 'it played most of the book').toBeGreaterThan(4);
    expect(indices, 'no paragraph was jumped over').toEqual(
      Array.from({ length: indices.length }, (_, i) => indices[0] + i),
    );
    expect(traceEvents(trace, 'ended').length, 'each one played to its end')
      .toBeGreaterThanOrEqual(indices.length - 1);

    expect(new Set(requested).size, 'a distinct MP3 was served per paragraph')
      .toBeGreaterThanOrEqual(indices.length);

    // The unhandled-rejection gate: `void this.next()` used to swallow an IDB
    // rejection here, and a page error is how that would surface.
    expect(page.pageErrors, 'no uncaught page errors during playback').toHaveLength(0);
    expect(spa.filterConsoleErrors(page.consoleErrors)).toHaveLength(0);
    spa.assertHealthy(await spa.healthCheck(page));
  });

  test('the pill stays put and visible for the whole run', async ({ page, spa }) => {
    test.setTimeout(180_000);

    await page.setViewportSize({ width: 900, height: 700 });
    await authorAudioBook(page, spa, { paragraphs: 5, title: 'Pill Visible' });
    await routeAudioManifest(page);
    await routeAudioFiles(page);

    await startListening(page);
    await waitForNodesStarted(page, 3);

    await expect(page.locator(PILL)).toHaveClass(/visible/);
    // The counter proves onEntryChange kept firing rather than the engine going
    // quiet with the UI frozen on paragraph 1.
    await expect(page.locator('#audio-status-text')).not.toHaveText('1 / 5');
  });
});

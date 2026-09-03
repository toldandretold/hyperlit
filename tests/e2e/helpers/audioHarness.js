/**
 * Real-media harness for the audio player specs.
 *
 * The older audio spec stubs `HTMLMediaElement.prototype.play` and points every
 * node at a 404ing `stub.mp3`, so `ended` never fires and playback never
 * advances — which means it structurally cannot cover anything about advancing,
 * speed continuity, or stall recovery. This harness serves a REAL (tiny, silent)
 * MP3 for every paragraph instead, so Chromium fires genuine
 * loadedmetadata/playing/timeupdate/ended events and the engine is exercised for
 * real. Do NOT stub play() in specs that use this.
 *
 * The <audio> element is DETACHED (never in the DOM), so no Playwright locator
 * can reach it. `window.__audioTrace` (audioTrace.ts) is the probe — hence
 * getTrace/waitForNodesStarted/attachTraceOnFailure below.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MP3 = readFileSync(resolve(HERE, '../fixtures/audio/silence-400ms.mp3'));

/** `/{bookId}/audio/{filename}.mp3` — the player's serve route. */
const AUDIO_FILE_RE = /\/audio\/[^/?#]+\.mp3(\?|$)/;

export const SCROLLER = '.reader-content-wrapper';
export const READING_CLASS = 'audio-reading';
export const PILL = '#audio-player-bar';

/**
 * Launch args for the real-media audio specs (use in `test.use({ launchOptions:
 * { args: AUDIO_LAUNCH_ARGS } })`).
 *
 * autoplay-policy / mute-audio: playback must advance across awaits without a
 * fresh gesture, silently.
 *
 * HardwareMediaKeyHandling + MediaSessionService are disabled because the HOST
 * machine's media events — a media-key press, AirPods ear-detection/hand-off,
 * screen lock — reach Chrome's media session while the audiobook plays and fire
 * the engine's mediaSession 'pause' action handler. That paused a run mid-book
 * with zero page-side cause (2026-09-03: continuity spec stalled at 5/10, trace
 * silent after 'playing' — the pause path now traces 'pause-requested', but the
 * spec must be immune, not merely diagnosable).
 *
 * GOTCHA: Chromium takes the LAST --disable-features switch verbatim (repeated
 * switches are not merged), and Playwright appends user args AFTER its own
 * defaults — so this switch CLOBBERS Playwright's default disabled-features
 * list. The tail of the list below re-states the Playwright defaults that
 * plausibly matter here; if a future Playwright adds one these specs depend on,
 * add it here too.
 */
export const AUDIO_LAUNCH_ARGS = [
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--disable-features=HardwareMediaKeyHandling,MediaSessionService,'
    + 'GlobalMediaControls,MediaRouter,DialMediaRouteProvider,Translate,'
    + 'HttpsUpgrades,PaintHolding,AvoidUnnecessaryBeforeUnloadCheckSync,'
    + 'DestroyProfileOnBrowserClose,ThirdPartyStoragePartitioning,'
    + 'LensOverlay,OptimizationHints',
];

/** Author an N-paragraph book and leave edit mode. */
export async function authorAudioBook(page, spa, { paragraphs = 6, title = 'Audio Harness' } = {}) {
  await spa.createNewBook(page, spa);

  await page.click('h1[id="100"]');
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);

  for (let i = 0; i < paragraphs; i++) {
    await page.keyboard.type(`Paragraph ${i} — narrated filler for the audio harness.`);
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(300);

  await page.evaluate(() => document.getElementById('editButton')?.click());
  await page.waitForFunction(() => window.isEditing === false, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);

  return { bookId: await spa.getCurrentBookId(page) };
}

/**
 * Route the manifest, giving each node its OWN filename (n0.mp3, n1.mp3, …).
 * The old spec's shared 'stub.mp3' makes per-node failure injection and per-node
 * assertions impossible.
 *
 * Returns the node ids in playback order, index-aligned with nX.mp3.
 */
export async function routeAudioManifest(page) {
  const order = await page.evaluate((sel) => {
    const root = document.querySelector(sel) ?? document;

    return [...root.querySelectorAll('[data-node-id]')]
      .map((el) => el.getAttribute('data-node-id'))
      .filter(Boolean);
  }, SCROLLER);

  const nodes = {};
  order.forEach((id, i) => {
    nodes[id] = { filename: `n${i}.mp3`, duration_ms: 400, stale: false, encrypted: false };
  });

  await page.route('**/api/book-audio/*/manifest', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ voice: null, nodes }),
  }));

  return order;
}

/**
 * Serve a real MP3 for every paragraph. `failures` maps a filename to
 * `{ mode, once }` where mode is 'abort' | 'server' | 'hang'; `once: true`
 * clears the fault after the first attempt, so a RETRY can succeed — that is how
 * a spec proves recovery rather than a skip.
 *
 * Returns a live array of every filename requested, in order (assert on repeats
 * to prove a retry actually happened).
 */
export async function routeAudioFiles(page, { failures = {} } = {}) {
  const requested = [];

  // A RegExp, not a glob: `**/*/audio/*.mp3` silently matched NOTHING against
  // the full URL, so every paragraph 404'd from the real server and the specs
  // "passed" a skip cascade instead of testing playback.
  await page.route(AUDIO_FILE_RE, async (route) => {
    const request = route.request();
    const name = new URL(request.url()).pathname.split('/').pop();

    // Faults apply ONLY to the <audio> element's own stream ('media'), never to
    // prefetchNext()'s warm-up fetch. Otherwise a `once: true` fault is absorbed
    // by the prefetch a paragraph early and playback never sees it at all —
    // which is how the retry assertion silently tested nothing. `requested`
    // likewise counts media loads only, so a repeat in it means a real retry.
    const isMedia = request.resourceType() === 'media';
    const attempt = requested.filter((r) => r === name).length;
    if (isMedia) requested.push(name);

    const fault = isMedia ? failures[name] : null;
    const mode = fault && (!fault.once || attempt === 0) ? fault.mode : null;

    if (mode === 'abort') return route.abort('failed');
    if (mode === 'server') {
      return route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' });
    }
    if (mode === 'hang') return; // never settles — the watchdog's target

    // `no-store` matters: without it a retry is served from the HTTP cache and
    // never re-enters this handler, so the retry assertion would pass for the
    // wrong reason.
    const headers = {
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };

    const range = route.request().headers().range;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(match?.[1] ?? 0);
      const end = match?.[2] ? Number(match[2]) : MP3.length - 1;

      return route.fulfill({
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${MP3.length}` },
        body: MP3.subarray(start, end + 1),
      });
    }

    return route.fulfill({ status: 200, headers, body: MP3 });
  });

  return requested;
}

/** Release any hung routes so a spec's teardown can't wedge. */
export async function unrouteAudio(page) {
  await page.unroute(AUDIO_FILE_RE).catch(() => {});
  await page.unroute('**/api/book-audio/*/manifest').catch(() => {});
}

/** The settings-menu Listen button is off-viewport — click it programmatically. */
export const startListening = (page) => page.evaluate(() => document.getElementById('audioListenButton')?.click());

export const getTrace = (page) => page.evaluate(() => window.__audioTrace?.get() ?? []);

/**
 * How many paragraphs the player actually queued, read off the pill's "3 / 7".
 *
 * Do NOT count DOM nodes for this: the playlist is IndexedDB order ∩ manifest,
 * and a freshly authored book's trailing empty paragraph is in the DOM but not
 * yet persisted — so a DOM count is one too many and every "wait for all of
 * them" times out. Call it once playback has started.
 */
export async function playlistTotal(page, timeout = 30_000) {
  // WAIT for it. The counter is written by onEntryChange, which runs only once
  // play() has actually resolved — reading it right after the first `node-start`
  // returns an empty string, and a total of 0 makes every subsequent
  // waitForNodesStarted() pass instantly against nothing.
  await page.waitForFunction(
    () => /\d+\s*\/\s*\d+/.test(document.getElementById('audio-status-text')?.textContent ?? ''),
    null,
    { timeout },
  );
  const text = await page.locator('#audio-status-text').textContent();
  const match = /(\d+)\s*\/\s*(\d+)/.exec(text ?? '');

  return match ? Number(match[2]) : 0;
}

/** Wait until `count` DISTINCT paragraphs have begun playing. */
export function waitForNodesStarted(page, count, timeout = 40_000) {
  if (count < 1) throw new Error(`waitForNodesStarted(${count}) would pass instantly — bad expectation`);

  return page.waitForFunction((n) => {
    const trace = window.__audioTrace?.get() ?? [];
    const started = new Set(trace.filter((e) => e.event === 'node-start').map((e) => e.nodeId));

    return started.size >= n;
  }, count, { timeout });
}

/**
 * Wait until the LAST paragraph of the playlist has started.
 *
 * Use this, not "wait for all `total` of them": playback deliberately begins at
 * the reader's CURRENT position (the audio-start-position invariant), so on a
 * book opened at the top it starts at index 1 and index 0 — the title — is never
 * played. "It got to the end without stopping" is the real invariant.
 */
export function waitForPlaybackToReachEnd(page, total, timeout = 60_000) {
  return page.waitForFunction((n) => {
    const trace = window.__audioTrace?.get() ?? [];

    return trace.some((e) => e.event === 'node-start' && e.index === n - 1);
  }, total, { timeout });
}

/** The playlist indices that were started, in order, without repeats. */
export function startedIndices(trace) {
  const indices = [];
  for (const entry of trace) {
    if (entry.event === 'node-start' && indices.at(-1) !== entry.index) indices.push(entry.index);
  }

  return indices;
}

/** Wait until a trace entry of this type shows up. */
export function waitForTraceEvent(page, event, timeout = 40_000) {
  return page.waitForFunction((name) => {
    const trace = window.__audioTrace?.get() ?? [];

    return trace.some((e) => e.event === name);
  }, event, { timeout });
}

export function traceEvents(trace, event) {
  return trace.filter((entry) => entry.event === event);
}

/** Attach the ring to the report on failure — it is the whole point of it. */
export async function attachTraceOnFailure(page, testInfo) {
  if (testInfo.status === testInfo.expectedStatus) return;
  const trace = await getTrace(page).catch(() => []);
  await testInfo.attach('audio-trace.json', {
    body: JSON.stringify(trace, null, 2),
    contentType: 'application/json',
  });
}

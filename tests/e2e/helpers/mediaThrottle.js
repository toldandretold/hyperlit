/**
 * Image throttle — `page.route` harness controlling WHEN image bytes land, so
 * specs can reproduce the cold-phone-cache case where images decode long after
 * the reader paints (every scroll-restore correction belt then fires).
 *
 * Two targets (globs spelled with a space to avoid comment-terminator traps):
 *   - book media:   `** /<bookId>/media/**` (or `** /media/**` before the id is
 *                   known) — bytes come from the real server via route.fetch().
 *   - remote imgs:  `https://img.test/...` — markdown refs to the fake host are
 *                   left untouched by the import rewriter, so node HTML carries
 *                   `<img src>` with NO width/height attributes (the unsized,
 *                   maximal-layout-shift case). Bytes come from `serve`.
 *
 * Modes: 'instant' | 'delay' (delayMs) | 'hold' (until release()) | 'stall'.
 * Every fulfill carries `Cache-Control: no-store` so a later navigation always
 * re-enters the handler — a warm HTTP cache would silently turn 'hold' into
 * 'instant' (same gotcha as the audio harness).
 */

const toPattern = (p) =>
  typeof p === 'string' && !p.includes('*') ? `**/${p}/media/**` : p;

/**
 * @param {Object} opts
 * @param {string | RegExp} opts.pattern glob/RegExp, or a bare bookId
 * @param {'instant' | 'delay' | 'hold' | 'stall'} [opts.mode]
 * @param {number} [opts.delayMs]
 * @param {function(string): (Buffer | null)} [opts.serve]  bytes for unfetchable
 *        URLs (the img.test fake host). Return null → 404.
 * @param {function(string): boolean} [opts.holdIf]  when the mode would hold,
 *        apply it only to URLs where this returns true (others pass instantly).
 *        Lets a spec hold the images of EARLY chapters only — restore lands on
 *        instant media while the above-marker images stay pending.
 */
export async function throttleImages(page, { pattern, mode = 'delay', delayMs = 350, serve = null, holdIf = null }) {
  const pat = toPattern(pattern);
  let currentMode = mode;
  let currentDelay = delayMs;
  let currentHoldIf = holdIf;
  let held = [];
  const requested = [];

  const respond = async (route) => {
    const url = route.request().url();
    const served = serve ? serve(url) : null;
    if (serve) {
      if (!served) return route.fulfill({ status: 404, body: 'img.test: unknown' });
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
        body: served,
      });
    }
    let response;
    try {
      response = await route.fetch();
    } catch {
      return route.abort().catch(() => {});
    }
    try {
      const buf = await response.arrayBuffer();
      const headers = { ...response.headers(), 'cache-control': 'no-store' };
      delete headers['content-length'];
      delete headers['content-encoding'];
      return await route.fulfill({ response, headers, body: Buffer.from(buf) });
    } catch {
      return route.continue().catch(() => {});
    }
  };

  await page.route(pat, async (route) => {
    const url = route.request().url();
    requested.push(url);
    const heldApplies = currentHoldIf ? currentHoldIf(url) : true;

    if (currentMode === 'instant' || !heldApplies) return respond(route);
    if (currentMode === 'stall') return; // never fulfills
    if (currentMode === 'hold') {
      await new Promise((resolve) => held.push(resolve));
      return respond(route);
    }
    await new Promise((r) => setTimeout(r, currentDelay));
    return respond(route);
  });

  return {
    release: () => {
      const pending = held;
      held = [];
      for (const r of pending) r();
    },
    setMode: (m, opts = {}) => {
      currentMode = m;
      if (opts.delayMs != null) currentDelay = opts.delayMs;
      if (opts.holdIf !== undefined) currentHoldIf = opts.holdIf;
    },
    requested: () => requested.slice(),
    unroute: async () => {
      const pending = held;
      held = [];
      for (const r of pending) r();
      await page.unroute(pat).catch(() => {});
    },
  };
}

/**
 * Slow the WHOLE context down (reload-under-throttle arm) via CDP network
 * emulation. Chromium-only — call sites must guard on browserName.
 */
export async function emulateSlowNetwork(page, { latencyMs = 400, downloadKbps = 400, uploadKbps = 400 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: latencyMs,
    downloadThroughput: downloadKbps * 1024,
    uploadThroughput: uploadKbps * 1024,
  });
  return cdp;
}

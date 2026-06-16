/**
 * Capture every request/response that matches a URL substring (default '/api/ai-brain').
 * Usage:
 *   const capture = startBrainNetworkCapture(page);
 *   ... do stuff ...
 *   const events = capture.events();   // [{url, method, status, body?, errorText?, postData?}]
 */
export function startBrainNetworkCapture(page, urlSubstring = '/api/ai-brain') {
  const events = [];

  const onRequest = (request) => {
    if (!request.url().includes(urlSubstring)) return;
    let postData = null;
    try { postData = request.postData(); } catch {}
    events.push({
      kind: 'request',
      url: request.url(),
      method: request.method(),
      postData,
      ts: Date.now(),
    });
  };

  const onResponse = async (response) => {
    if (!response.url().includes(urlSubstring)) return;
    const url = response.url();
    const status = response.status();
    let body = null;
    const headers = response.headers();
    const ct = headers['content-type'] || '';
    try {
      if (ct.includes('text/event-stream')) {
        body = '[SSE stream — body not captured here]';
      } else {
        body = await response.text();
        if (body && body.length > 4000) body = body.slice(0, 4000) + '\n...[truncated]';
      }
    } catch (e) {
      body = `[body read failed: ${e.message}]`;
    }
    events.push({
      kind: 'response',
      url,
      status,
      contentType: ct,
      body,
      ts: Date.now(),
    });
  };

  const onRequestFailed = (request) => {
    if (!request.url().includes(urlSubstring)) return;
    events.push({
      kind: 'requestfailed',
      url: request.url(),
      method: request.method(),
      errorText: request.failure()?.errorText || 'unknown',
      ts: Date.now(),
    });
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  return {
    events: () => events.slice(),
    stop: () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
    },
  };
}

/**
 * Capture every .js chunk the page downloads (the real, browser-measured initial-load surface).
 * Used by the bundle-size perf spec to verify lazy chunks (editor/paste-system) do NOT load until
 * the feature is used. Records bytes from the content-length header (transferred ≈ over the wire).
 *
 *   const js = startJsChunkCapture(page);
 *   await page.goto('/book'); await page.waitForLoadState('networkidle');
 *   const initial = js.snapshot();        // {chunks:[{file,kb}], totalKB}
 *   ... enter edit mode ...
 *   const afterEdit = js.since(initial);  // chunks fetched AFTER the snapshot
 */
export function startJsChunkCapture(page) {
  const seen = []; // {file, url, bytes, ts, built}
  const onResponse = (response) => {
    const url = response.url();
    // Capture any JS/TS module response (prod built chunk OR Vite-dev unbundled module), so the spec
    // can tell which environment it's in. `built` flags real production chunks (/build/assets/*.js).
    if (!/\.(js|ts|mjs)(\?|$)/.test(url)) return;
    if (!/\.(js|ts|mjs)\b/.test(url)) return;
    const len = Number(response.headers()['content-length'] || 0);
    seen.push({ file: url.split('/').pop().split('?')[0], url, bytes: len, ts: Date.now(), built: url.includes('/build/assets/') });
  };
  page.on('response', onResponse);

  const summarize = (list) => ({
    chunks: list.map((c) => ({ file: c.file, kb: +(c.bytes / 1024).toFixed(1) })),
    totalKB: +(list.reduce((s, c) => s + c.bytes, 0) / 1024).toFixed(1),
    files: list.map((c) => c.file),
    builtCount: list.filter((c) => c.built).length, // >0 ⟹ running against a production build
  });

  return {
    snapshot: () => { const list = seen.slice(); return { ...summarize(list), _mark: list.length }; },
    since: (snap) => summarize(seen.slice(snap._mark)),
    all: () => summarize(seen.slice()),
    stop: () => page.off('response', onResponse),
  };
}

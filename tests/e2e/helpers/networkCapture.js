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

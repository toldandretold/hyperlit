/**
 * GATE: the service worker treats a 5xx on an HTML navigation as an OUTAGE.
 *
 * "Local mode" used to engage only when fetch() REJECTED. But an outage is
 * usually a successful fetch carrying an error page: Cloudflare answers 521
 * when the origin is down (observed 2026-11-18 during a kernel reboot), nginx
 * answers 502 while PHP-FPM restarts on a deploy. The worker handed those
 * straight to the reader, who saw "Web server is down" with the whole book
 * sitting in cache. Now any 5xx falls back to the cached page like a dropped
 * connection does — but only when something IS cached: a first-time visitor
 * gets the real error page, not a false "You're offline".
 *
 * Drives public/sw.js for real: the file is evaluated with stub `self`,
 * `caches` and `fetch`, and the captured fetch listener is handed a navigation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ORIGIN = 'https://hyperlit.io';
const SW_SRC = readFileSync(resolve(__dirname, '../../../public/sw.js'), 'utf8');

function loadWorker({ fetchImpl, cached = {} }) {
  const listeners = {};
  const store = new Map(Object.entries(cached));
  const keyOf = (req) => {
    const u = typeof req === 'string' ? req : req.url;
    return u.startsWith('http') ? new URL(u).pathname : u;
  };
  const cache = {
    match: async (req) => { const r = store.get(keyOf(req)); return r ? r.clone() : undefined; },
    put: async () => {},
    addAll: async () => {},
    keys: async () => [...store.keys()].map((k) => new Request(ORIGIN + k)),
  };
  const caches = { open: async () => cache, match: cache.match, keys: async () => [], delete: async () => true };
  const self = {
    location: new URL(ORIGIN + '/sw.js?v=btest'),
    addEventListener: (name, fn) => { listeners[name] = fn; },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };
  const quiet = { log() {}, warn() {}, error() {}, info() {} };
  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'fetch', 'console', SW_SRC)(self, caches, fetchImpl, quiet);
  return listeners;
}

async function navigate(listeners, path) {
  let responded;
  listeners.fetch({
    request: new Request(ORIGIN + path, { method: 'GET', headers: { accept: 'text/html' } }),
    respondWith: (p) => { responded = p; },
  });
  expect(responded, 'the worker did not claim the navigation').toBeTruthy();
  return responded;
}

const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html' } });

describe('service worker: HTML navigation during an outage', () => {
  it('serves the cached page when the origin answers a Cloudflare 521', async () => {
    const listeners = loadWorker({
      fetchImpl: async () => html('<h1>Web server is down</h1>', 521),
      cached: { '/book_1': html('<html><main id="book_1" class="main-content">cached book</main></html>') },
    });
    const res = await navigate(listeners, '/book_1');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('cached book');
  });

  it('serves the cached page on a 502 from nginx during a deploy', async () => {
    const listeners = loadWorker({
      fetchImpl: async () => html('Bad Gateway', 502),
      cached: { '/': html('<html>cached home</html>') },
    });
    const res = await navigate(listeners, '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('cached home');
  });

  it('hands a first-time visitor the real error page rather than a fake "offline" page', async () => {
    const listeners = loadWorker({ fetchImpl: async () => html('<h1>Web server is down</h1>', 521), cached: {} });
    const res = await navigate(listeners, '/book_1');
    expect(res.status).toBe(521);
    expect(await res.text()).toContain('Web server is down');
  });

  it('still serves the offline page when the connection itself is gone and nothing is cached', async () => {
    const listeners = loadWorker({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, cached: {} });
    const res = await navigate(listeners, '/book_1');
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/offline/i);
  });

  it('passes a healthy 200 and a genuine 404 through untouched (controls)', async () => {
    const ok = loadWorker({ fetchImpl: async () => html('<html>fresh</html>'), cached: { '/': html('<html>stale</html>') } });
    expect(await (await navigate(ok, '/')).text()).toBe('<html>fresh</html>');

    const missing = loadWorker({ fetchImpl: async () => html('Not Found', 404), cached: { '/nope': html('<html>stale</html>') } });
    const res = await navigate(missing, '/nope');
    expect(res.status).toBe(404);
  });
});

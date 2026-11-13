/**
 * The export button's wait must survive an unreadable status poll.
 *
 * Prod 2026-11-13: "Fetch API cannot load …/status?kind=markdown due to access
 * control checks" — Safari's wording for an in-flight fetch it killed (tab
 * backgrounded / phone locked). fetchStatus returned null, apply(null) bailed
 * WITHOUT rescheduling, and the wait ended silently: button dimmed forever,
 * artifact never downloaded. A build is minutes long; one failed read is routine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const alertDialog = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../../resources/js/components/dialog/dialog', () => ({ alertDialog }));
vi.mock('../../../resources/js/utilities/auth/csrf', () => ({
  ensureCsrfToken: vi.fn().mockResolvedValue('tok'),
}));

import { initExportDownload } from '../../../resources/js/components/archivePanel/exportDownload';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Scripted server: each status GET shifts the next reply; a function reply may throw. */
function scriptFetch(statusReplies) {
  const calls = { status: 0, build: 0 };
  globalThis.fetch = vi.fn(async (url, init) => {
    if (init?.method === 'POST') {
      calls.build++;
      return json({ success: true, state: 'building' }, 202);
    }
    calls.status++;
    const next = statusReplies.length > 1 ? statusReplies.shift() : statusReplies[0];
    return typeof next === 'function' ? next() : json(next);
  });
  return calls;
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await vi.dynamicImportSettled(); for (let i = 0; i < 5; i++) await Promise.resolve(); };
const tick = async (ms = 2000) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };

describe('archive export button: polling resilience', () => {
  let button; let handle; let clicks;

  beforeEach(() => {
    vi.useFakeTimers();
    alertDialog.mockClear();
    document.body.innerHTML = '<div id="c"><button id="b"><span class="export-progress"></span></button></div>';
    button = document.getElementById('b');
    clicks = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { clicks.push(this.getAttribute('href')); });
  });
  afterEach(() => {
    handle?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const arm = async () => {
    handle = initExportDownload(document.getElementById('c'), 'b', { scopeType: 'archive', scopeId: 'decolonising-security' }, 'markdown');
    await flush();
    button.click();
    await flush();
  };

  it('keeps waiting through a thrown fetch and a 502, then downloads', async () => {
    scriptFetch([
      { state: 'buildable' },                      // initial arm
      { state: 'building', progress: 0.1 },        // right after the build POST
      () => { throw new TypeError('Load failed'); }, // Safari killed the poll
      () => new Response('bad gateway', { status: 502 }),
      { state: 'building', progress: 0.6 },
      { state: 'ready', bytes: 10 },
    ]);
    await arm();
    expect(button.disabled).toBe(true);

    await tick(); // thrown
    expect(button.disabled).toBe(true);
    await tick(); // 502
    expect(button.disabled).toBe(true);
    await tick(); // building 60%
    expect(button.querySelector('.export-progress').textContent).toBe('60%');
    await tick(); // ready
    expect(clicks).toEqual(['/exports/archive/decolonising-security/markdown']);
    expect(button.disabled).toBe(false);
    expect(alertDialog).not.toHaveBeenCalled();
  });

  it('a build that goes building → buildable (dead/absent worker) releases the button and says so', async () => {
    scriptFetch([
      { state: 'buildable' },
      { state: 'building', progress: 0 },
      { state: 'buildable', message: null },
    ]);
    await arm();
    await tick();
    await flush();
    expect(button.disabled).toBe(false);
    expect(alertDialog).toHaveBeenCalledTimes(1);
    expect(clicks).toEqual([]);
  });

  it('gives up — visibly — after a sustained outage, not on the first failure', async () => {
    const calls = scriptFetch([
      { state: 'buildable' },
      { state: 'building', progress: 0 },
      () => { throw new TypeError('Load failed'); },
    ]);
    await arm();
    for (let i = 0; i < 29; i++) await tick();
    expect(button.disabled).toBe(true);
    expect(alertDialog).not.toHaveBeenCalled();
    await tick();
    await flush();
    expect(button.disabled).toBe(false);
    expect(alertDialog).toHaveBeenCalledTimes(1);
    const settled = calls.status;
    await tick(10000);
    expect(calls.status).toBe(settled); // polling really stopped
  });
});

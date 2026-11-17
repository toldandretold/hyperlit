/**
 * The vault's "include texts cited by this collection" option rides every
 * request of the export button: status polls, the build POST and the download
 * href. It is read at arm / press / refresh and FROZEN for a wait, so toggling
 * mid-build cannot make the poll watch the other variant. The SQLite kind
 * never carries it, and a button armed without the option sends nothing (the
 * server default applies).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const alertDialog = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../../resources/js/components/dialog/dialog', () => ({ alertDialog }));
vi.mock('../../../resources/js/utilities/auth/csrf', () => ({
  ensureCsrfToken: vi.fn().mockResolvedValue('tok'),
}));

import { initExportDownload } from '../../../resources/js/components/archivePanel/exportDownload';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function scriptFetch(statusReplies) {
  const calls = { status: [], build: [] };
  globalThis.fetch = vi.fn(async (url, init) => {
    if (init?.method === 'POST') {
      calls.build.push(JSON.parse(init.body));
      return json({ success: true, state: 'building' }, 202);
    }
    calls.status.push(String(url));
    const next = statusReplies.length > 1 ? statusReplies.shift() : statusReplies[0];
    return json(next);
  });
  return calls;
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await vi.dynamicImportSettled(); for (let i = 0; i < 5; i++) await Promise.resolve(); };
const tick = async (ms = 2000) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };
const scope = { scopeType: 'archive', scopeId: 'decolonising-security' };

describe('archive export button: the cited-texts option', () => {
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

  it('sends cited=1 on status, build and download when the option is on', async () => {
    const calls = scriptFetch([{ state: 'buildable' }, { state: 'ready', bytes: 5 }]);
    handle = initExportDownload(document.getElementById('c'), 'b', scope, 'markdown', { includeCited: () => true });
    await flush();
    expect(calls.status[0]).toBe('/api/archive-export/archive/decolonising-security/status?kind=markdown&cited=1');

    button.click();
    await flush();
    expect(calls.build).toEqual([{ kind: 'markdown', cited: 1 }]);
    await tick();
    expect(clicks).toEqual(['/exports/archive/decolonising-security/markdown?cited=1']);
  });

  it('sends cited=0 when the option is off, and a press re-reads the option', async () => {
    let on = false;
    const calls = scriptFetch([{ state: 'buildable' }, { state: 'ready', bytes: 5 }]);
    handle = initExportDownload(document.getElementById('c'), 'b', scope, 'zettlr', { includeCited: () => on });
    await flush();
    expect(calls.status[0]).toContain('kind=zettlr&cited=0');

    on = true; // the user ticks the box, then presses
    button.click();
    await flush();
    expect(calls.build).toEqual([{ kind: 'zettlr', cited: 1 }]);
    await tick();
    expect(clicks).toEqual(['/exports/archive/decolonising-security/zettlr?cited=1']);
  });

  it('freezes the variant for the length of a wait: a toggle mid-build changes nothing until the download lands', async () => {
    let on = true;
    const calls = scriptFetch([
      { state: 'buildable' },
      { state: 'building', progress: 0.2 },
      { state: 'building', progress: 0.7 },
      { state: 'ready', bytes: 5 },
    ]);
    handle = initExportDownload(document.getElementById('c'), 'b', scope, 'markdown', { includeCited: () => on });
    await flush();
    button.click();
    await flush();
    on = false; // flipped while the build runs
    handle.refresh(); // the panel would call this on change — ignored mid-wait
    await tick();
    await tick();
    await tick();
    expect(calls.status.every((u) => u.endsWith('&cited=1'))).toBe(true);
    expect(clicks).toEqual(['/exports/archive/decolonising-security/markdown?cited=1']);
  });

  it('refresh() while idle re-reads the option and re-fetches status for the other variant', async () => {
    let on = true;
    const calls = scriptFetch([{ state: 'ready', bytes: 5 }]);
    handle = initExportDownload(document.getElementById('c'), 'b', scope, 'markdown', { includeCited: () => on });
    await flush();
    on = false;
    handle.refresh();
    await flush();
    expect(calls.status).toEqual([
      '/api/archive-export/archive/decolonising-security/status?kind=markdown&cited=1',
      '/api/archive-export/archive/decolonising-security/status?kind=markdown&cited=0',
    ]);
  });

  it('the SQLite kind and a button without the option send no cited parameter', async () => {
    const calls = scriptFetch([{ state: 'buildable' }, { state: 'ready', bytes: 5 }]);
    handle = initExportDownload(document.getElementById('c'), 'b', scope, 'sqlite', { includeCited: () => true });
    await flush();
    expect(calls.status[0]).toBe('/api/archive-export/archive/decolonising-security/status?kind=sqlite');
    button.click();
    await flush();
    expect(calls.build).toEqual([{ kind: 'sqlite' }]);
    await tick();
    expect(clicks).toEqual(['/exports/archive/decolonising-security/sqlite']);
    handle.destroy();

    const calls2 = scriptFetch([{ state: 'buildable' }]);
    handle = initExportDownload(document.getElementById('c'), 'b', scope, 'markdown');
    await flush();
    expect(calls2.status[0]).toBe('/api/archive-export/archive/decolonising-security/status?kind=markdown');
  });
});

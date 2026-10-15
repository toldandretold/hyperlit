/**
 * The "download the original PDF" button ("PDF phile") —
 * resources/js/components/sourceContainer/originalPdfDownload.ts.
 *
 * The button is rendered hidden and revealed by ONE HEAD probe against
 * /{book}/original.pdf itself: 200 means "the file exists and this reader may
 * have it"; 403/404/offline all mean "no button". What these pin: the probe
 * is drained HEAD-with-credentials, synthetic/sub-books are never probed at
 * all, and a probe resolving after destroy() cannot un-hide a torn-down
 * panel's button.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { init: vi.fn(), nav: vi.fn(), content: vi.fn(), user: vi.fn(), error: vi.fn() },
  verbose: { init: vi.fn(), nav: vi.fn(), content: vi.fn(), user: vi.fn() },
  isVerboseEnabled: () => false,
}));
// helpers.ts (the REAL isSyntheticBook is under test) pulls the IDB layer in
// for its other exports — stub that boundary, nothing in it runs here.
vi.mock('../../../resources/js/indexedDB/index', () => ({
  openDatabase: vi.fn(async () => ({})),
}));

import { initOriginalPdfDownload } from '../../../resources/js/components/sourceContainer/originalPdfDownload';

const BOOK = 'book_1';

let container;
let button;
let handle;
let clicked;

function buildDom() {
  document.body.innerHTML = `
    <div id="source-container">
      <button type="button" id="download-original-pdf" hidden>
        <div class="icon-wrapper"><svg class="download-icon"></svg></div>
      </button>
    </div>`;
  container = document.getElementById('source-container');
  button = document.getElementById('download-original-pdf');
}

/** A bodyless HEAD response that still satisfies drainResponse's .blob(). */
function headResponse(ok, status = ok ? 200 : 404) {
  return { ok, status, blob: async () => new Blob([]) };
}

beforeEach(() => {
  buildDom();
  clicked = [];
  globalThis.fetch = vi.fn(async () => headResponse(true));
  // Capture the synthetic <a download> click instead of navigating.
  HTMLAnchorElement.prototype.click = function () { clicked.push(this.href); };
});

afterEach(() => {
  handle?.destroy();
  handle = null;
});

/** Drain microtasks (the probe fetch and its awaited drain). */
async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe('reveal and hide', () => {
  it('reveals the button when the HEAD probe answers 200', async () => {
    handle = initOriginalPdfDownload(container, BOOK);
    await flush();

    expect(button.hidden).toBe(false);
    expect(button.title).toContain('original PDF');
    expect(button.getAttribute('aria-label')).toContain('original PDF');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/book_1/original.pdf');
    expect(init).toMatchObject({ method: 'HEAD', credentials: 'include' });
  });

  it('stays hidden when there is no original PDF (404)', async () => {
    globalThis.fetch = vi.fn(async () => headResponse(false, 404));
    handle = initOriginalPdfDownload(container, BOOK);
    await flush();

    expect(button.hidden).toBe(true);
  });

  it('stays hidden when access is refused (403)', async () => {
    globalThis.fetch = vi.fn(async () => headResponse(false, 403));
    handle = initOriginalPdfDownload(container, BOOK);
    await flush();

    expect(button.hidden).toBe(true);
  });

  it('stays hidden (and does not throw) when the probe fails outright', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('offline'); });
    handle = initOriginalPdfDownload(container, BOOK);
    await flush();

    expect(button.hidden).toBe(true);
  });

  it('never probes synthetic books or sub-books', async () => {
    expect(initOriginalPdfDownload(container, 'most-recent')).toBe(null);
    expect(initOriginalPdfDownload(container, 'book_1/Fn2')).toBe(null);
    await flush();

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(button.hidden).toBe(true);
  });

  it('a probe that resolves after destroy() cannot un-hide the button', async () => {
    let resolveProbe;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { resolveProbe = resolve; }));
    handle = initOriginalPdfDownload(container, BOOK);
    handle.destroy();
    handle = null;
    resolveProbe(headResponse(true));
    await flush();

    expect(button.hidden).toBe(true);
  });
});

describe('download', () => {
  it('clicking hands the browser the attachment URL via a synthetic anchor', async () => {
    handle = initOriginalPdfDownload(container, BOOK);
    await flush();

    button.click();

    expect(clicked).toHaveLength(1);
    expect(clicked[0]).toContain('/book_1/original.pdf');
    // The synthetic anchor must not linger in the DOM.
    expect(document.querySelector('a[download]')).toBe(null);
  });

  it('a destroyed handle no longer responds to clicks', async () => {
    handle = initOriginalPdfDownload(container, BOOK);
    await flush();
    handle.destroy();
    handle = null;

    button.click();

    expect(clicked).toHaveLength(0);
  });
});

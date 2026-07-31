/**
 * The audiobook download button's state machine
 * (resources/js/components/sourceContainer/audiobookDownload.ts).
 *
 * The button has to be honest about three different situations that all look
 * like "you can't download yet": no narration at all, a host without ffmpeg,
 * and work in flight (either the narration run or the .m4b packaging). It also
 * has to survive the gap between asking for a build and the worker actually
 * starting — a single 'buildable' reading in that window used to cancel the
 * download the user asked for.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initAudiobookDownload } from '../../../resources/js/components/sourceContainer/audiobookDownload';

vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { init: vi.fn(), nav: vi.fn(), content: vi.fn(), user: vi.fn(), error: vi.fn() },
  verbose: { init: vi.fn(), nav: vi.fn(), content: vi.fn(), user: vi.fn() },
  isVerboseEnabled: () => false,
}));
vi.mock('../../../resources/js/utilities/auth/csrf', () => ({
  ensureCsrfToken: vi.fn(async () => 'test-token'),
}));

const BOOK = 'book_1';

function status(overrides = {}) {
  return {
    supported: true,
    state: 'buildable',
    progress: 0,
    message: null,
    sections: 12,
    total_nodes: 12,
    audio_nodes: 12,
    stale_nodes: 0,
    generating: false,
    bytes: 0,
    ...overrides,
  };
}

let container;
let button;
let handle;
/** Queue of GET responses; the last one repeats. */
let statusQueue;
let postResponse;
let clicked;

function buildDom() {
  document.body.innerHTML = `
    <div id="source-container">
      <button type="button" id="download-audiobook" hidden>
        <div class="icon-wrapper">
          <svg class="download-icon"></svg>
          <span class="audiobook-progress"></span>
        </div>
      </button>
    </div>`;
  container = document.getElementById('source-container');
  button = document.getElementById('download-audiobook');
}

beforeEach(() => {
  vi.useFakeTimers();
  buildDom();
  statusQueue = [status()];
  postResponse = { ok: true, status: 202, json: async () => ({ success: true, state: 'building' }) };
  clicked = [];

  globalThis.fetch = vi.fn(async (url, init) => {
    if (init?.method === 'POST') return postResponse;
    const next = statusQueue.length > 1 ? statusQueue.shift() : statusQueue[0];

    return { ok: true, json: async () => next };
  });

  // Capture the synthetic <a download> click instead of navigating.
  HTMLAnchorElement.prototype.click = function () { clicked.push(this.href); };
});

afterEach(() => {
  handle?.destroy();
  handle = null;
  vi.useRealTimers();
});

/** Drain microtasks (the initial status fetch and its chained .then). */
async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

async function tick(ms) {
  await flush();
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

describe('reveal and hide', () => {
  it('stays hidden when the host cannot package audiobooks', async () => {
    statusQueue = [{ supported: false, reason: 'ffmpeg_missing', state: 'unavailable' }];
    handle = initAudiobookDownload(container, BOOK);
    await flush();

    expect(button.hidden).toBe(true);
  });

  it('stays hidden for an encrypted book', async () => {
    statusQueue = [{ supported: false, reason: 'encrypted', state: 'unavailable' }];
    handle = initAudiobookDownload(container, BOOK);
    await flush();

    expect(button.hidden).toBe(true);
  });

  it('stays hidden when the book has no narration at all', async () => {
    statusQueue = [status({ state: 'empty', sections: 0 })];
    handle = initAudiobookDownload(container, BOOK);
    await flush();

    expect(button.hidden).toBe(true);
  });

  it('appears once there is something to package', async () => {
    handle = initAudiobookDownload(container, BOOK);
    await flush();

    expect(button.hidden).toBe(false);
    expect(button.classList.contains('is-busy')).toBe(false);
  });
});

describe('what the button says', () => {
  it('names the size and format when one is ready', async () => {
    statusQueue = [status({ state: 'ready', bytes: 29 * 1048576, sections: 169 })];
    handle = initAudiobookDownload(container, BOOK);
    await flush();

    expect(button.title).toContain('169 sections');
    expect(button.title).toContain('29 MB');
    expect(button.title).toContain('.m4b with chapters');
  });

  it('owns up to a coverage gap instead of nagging with a dialog', async () => {
    statusQueue = [status({ total_nodes: 100, audio_nodes: 88, stale_nodes: 5 })];
    handle = initAudiobookDownload(container, BOOK);
    await flush();

    expect(button.title).toContain('12 sections not narrated yet');
    expect(button.title).toContain('5 edited since narration');
  });

  it('says nothing about coverage when the book is fully narrated', async () => {
    handle = initAudiobookDownload(container, BOOK);
    await flush();

    expect(button.title).not.toContain('not narrated');
  });
});

describe('busy states', () => {
  it('dims while the book is still being narrated', async () => {
    statusQueue = [status({ generating: true })];
    handle = initAudiobookDownload(container, BOOK);
    await flush();

    expect(button.hidden).toBe(false);
    expect(button.classList.contains('is-busy')).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('Narrating');
  });

  it('shows a percentage while packaging', async () => {
    statusQueue = [status({ state: 'building', progress: 0.42 })];
    handle = initAudiobookDownload(container, BOOK);
    await flush();

    expect(button.classList.contains('is-busy')).toBe(true);
    expect(container.querySelector('.audiobook-progress').textContent).toBe('42%');
  });

  it('keeps polling and updating the percentage until it is ready', async () => {
    statusQueue = [
      status({ state: 'building', progress: 0.1 }),
      status({ state: 'building', progress: 0.8 }),
      status({ state: 'ready', bytes: 1048576 }),
    ];
    handle = initAudiobookDownload(container, BOOK);
    await flush();
    expect(container.querySelector('.audiobook-progress').textContent).toBe('10%');

    await tick(2100);
    expect(container.querySelector('.audiobook-progress').textContent).toBe('80%');

    await tick(2100);
    expect(button.classList.contains('is-busy')).toBe(false);
    expect(button.disabled).toBe(false);
  });
});

describe('downloading', () => {
  it('downloads immediately when one is already packaged', async () => {
    statusQueue = [status({ state: 'ready', bytes: 1048576 })];
    handle = initAudiobookDownload(container, BOOK);
    await flush();

    button.click();
    await flush();

    expect(globalThis.fetch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'POST' }));
    expect(clicked).toHaveLength(1);
    expect(clicked[0]).toContain(`/${BOOK}/audiobook.m4b`);
  });

  it('asks for a build, waits, then downloads the result', async () => {
    statusQueue = [
      status(),                                     // initial: buildable
      status({ state: 'building', progress: 0.2 }), // the refresh right after POST
      status({ state: 'building', progress: 0.5 }), // first poll
      status({ state: 'ready', bytes: 1048576 }),   // second poll
    ];
    handle = initAudiobookDownload(container, BOOK);
    await flush();

    button.click();
    await flush();
    expect(button.classList.contains('is-busy')).toBe(true);

    await tick(2100); // building
    expect(clicked).toHaveLength(0);

    await tick(2100); // ready → auto-download
    expect(clicked).toHaveLength(1);
    expect(button.classList.contains('is-busy')).toBe(false);
  });

  it('does not give up when the first poll after dispatch still says buildable', async () => {
    // The worker has not picked the job up yet. This exact window used to
    // clear the pending download and leave the user with nothing.
    statusQueue = [
      status(),
      status(),                                  // still no sign of the build
      status({ state: 'building', progress: 0.3 }),
      status({ state: 'ready', bytes: 1048576 }),
    ];
    handle = initAudiobookDownload(container, BOOK);
    await flush();

    button.click();
    await flush();

    await tick(2100);
    expect(button.classList.contains('is-busy'), 'still waiting on the build it asked for').toBe(true);

    await tick(2100);
    await tick(2100);
    expect(clicked).toHaveLength(1);
  });

  it('stops waiting when the build reports a failure', async () => {
    statusQueue = [
      status(),
      status({ state: 'buildable', message: 'Audiobook packaging failed.' }),
    ];
    handle = initAudiobookDownload(container, BOOK);
    await flush();

    button.click();
    await flush();
    await tick(2100);

    expect(button.classList.contains('is-busy')).toBe(false);
    expect(clicked).toHaveLength(0);
  });

  it('surfaces a refusal from the server instead of spinning forever', async () => {
    postResponse = { ok: false, status: 422, json: async () => ({ message: 'This book has no narrated sections yet.' }) };
    handle = initAudiobookDownload(container, BOOK);
    await flush();

    button.click();
    await flush(60);

    expect(button.classList.contains('is-busy')).toBe(false);
    expect(clicked).toHaveLength(0);
  });
});

describe('lifecycle', () => {
  it('stops polling on destroy, so a closed panel leaves no timer behind', async () => {
    statusQueue = [status({ state: 'building', progress: 0.2 })];
    handle = initAudiobookDownload(container, BOOK);
    await flush();
    const callsAtDestroy = globalThis.fetch.mock.calls.length;

    handle.destroy();
    handle = null;
    await tick(10_000);

    expect(globalThis.fetch.mock.calls.length).toBe(callsAtDestroy);
  });

  it('ignores clicks after destroy', async () => {
    statusQueue = [status({ state: 'ready', bytes: 1048576 })];
    handle = initAudiobookDownload(container, BOOK);
    await flush();

    handle.destroy();
    handle = null;
    button.click();
    await flush();

    expect(clicked).toHaveLength(0);
  });
});

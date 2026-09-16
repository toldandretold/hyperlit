/**
 * Reading-depth telemetry accumulates the chunks a reader actually had on
 * screen (piggybacking the scroll detector) and flushes the FULL cumulative
 * set via sendBeacon. Pinned here:
 *   1. Only chunks isWithinViewport approves are recorded — "in DOM" ≠ "read".
 *   2. Sub-books ("book_X/HL_Y") and non-reader pages (home/user feeds render
 *      synthetic books through the same lazyLoader) never record.
 *   3. A book switch flushes the OLD book's set before resetting — and the
 *      payload carries the old book's id, not the new one's.
 *   4. flush is dirty-gated: no new chunks since the last flush ⇒ no request.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const isWithinViewport = vi.hoisted(() => vi.fn());
vi.mock('../../../resources/js/lazyLoader/utilities/windowChunks', () => ({ isWithinViewport }));
vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn() },
  verbose: { content: vi.fn() },
}));

function makeContainer(chunkIds, visibleIds) {
  const container = document.createElement('div');
  for (const id of chunkIds) {
    const chunk = document.createElement('div');
    chunk.className = 'chunk';
    chunk.setAttribute('data-chunk-id', String(id));
    container.appendChild(chunk);
  }
  isWithinViewport.mockImplementation(
    (el) => visibleIds.map(String).includes(el.getAttribute('data-chunk-id')),
  );
  document.body.appendChild(container);
  return container;
}

let sendBeacon;

async function freshModule() {
  vi.resetModules();
  return await import('../../../resources/js/scrolling/readingTelemetry');
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.setAttribute('data-page', 'reader');
  delete window.chunkManifest;
  sendBeacon = vi.fn(() => true);
  navigator.sendBeacon = sendBeacon;
  global.fetch = vi.fn().mockResolvedValue({ ok: true });
});

async function readBlob(blob) {
  return JSON.parse(await blob.text());
}

describe('readingTelemetry', () => {
  it('records only the chunks that are actually on screen, cumulatively', async () => {
    const { recordVisibleChunks, flushReadingTelemetry } = await freshModule();
    const container = makeContainer([0, 1, 2, 3], [0, 1]);

    recordVisibleChunks('book_A', container, window);
    // Scrolled: chunk 2 comes into view (0 stays counted from before).
    isWithinViewport.mockImplementation((el) => el.getAttribute('data-chunk-id') === '2');
    recordVisibleChunks('book_A', container, window);

    flushReadingTelemetry();

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0];
    expect(url).toBe('/api/database-to-indexeddb/books/book_A/read-telemetry');
    const payload = await readBlob(blob);
    expect(payload.chunks.sort()).toEqual([0, 1, 2]);
  });

  it('captures total_chunks from the manifest while it is still present', async () => {
    const { recordVisibleChunks, flushReadingTelemetry } = await freshModule();
    window.chunkManifest = [{}, {}, {}]; // 3 chunks
    const container = makeContainer([0], [0]);

    recordVisibleChunks('book_A', container, window);
    window.chunkManifest = null; // background download completed
    recordVisibleChunks('book_A', container, window);
    flushReadingTelemetry();

    const payload = await readBlob(sendBeacon.mock.calls[0][1]);
    expect(payload.total_chunks).toBe(3);
  });

  it('never records sub-books or non-reader pages', async () => {
    const { recordVisibleChunks, flushReadingTelemetry } = await freshModule();
    const container = makeContainer([0], [0]);

    recordVisibleChunks('book_A/HL_9', container, window); // sub-book popover

    document.body.setAttribute('data-page', 'user');
    recordVisibleChunks('book_A', container, window); // feed page synthetic book

    flushReadingTelemetry();
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a book switch flushes the old book, then starts a fresh set', async () => {
    const { recordVisibleChunks, flushReadingTelemetry } = await freshModule();
    const container = makeContainer([0, 5], [0]);

    recordVisibleChunks('book_A', container, window);

    // SPA nav into book_B: same call site, new book id.
    isWithinViewport.mockImplementation((el) => el.getAttribute('data-chunk-id') === '5');
    recordVisibleChunks('book_B', container, window);

    // The switch itself flushed book_A.
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const first = await readBlob(sendBeacon.mock.calls[0][1]);
    expect(sendBeacon.mock.calls[0][0]).toContain('book_A');
    expect(first.chunks).toEqual([0]);

    flushReadingTelemetry();
    const second = await readBlob(sendBeacon.mock.calls[1][1]);
    expect(sendBeacon.mock.calls[1][0]).toContain('book_B');
    expect(second.chunks).toEqual([5]); // book_A's chunk 0 did NOT leak across
  });

  it('flush is a no-op when nothing new accumulated', async () => {
    const { recordVisibleChunks, flushReadingTelemetry } = await freshModule();
    const container = makeContainer([0], [0]);

    recordVisibleChunks('book_A', container, window);
    flushReadingTelemetry();
    flushReadingTelemetry(); // nothing new since the last flush

    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it('falls back to keepalive fetch when sendBeacon is unavailable', async () => {
    const { recordVisibleChunks, flushReadingTelemetry } = await freshModule();
    navigator.sendBeacon = undefined;
    const container = makeContainer([0], [0]);

    recordVisibleChunks('book_A', container, window);
    flushReadingTelemetry();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('book_A');
    expect(opts.keepalive).toBe(true);
    expect(JSON.parse(opts.body).chunks).toEqual([0]);
  });
});

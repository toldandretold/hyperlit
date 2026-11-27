/**
 * Shelf views: opening a shelf's feed (archive / journal page, or a shelf tab
 * on a user page) posts `shelf:{uuid}` to the page-view endpoint. Pinned here:
 *   1. Only shelf feed render ids count — any other feed id is ignored.
 *   2. The key is the shelf UUID, lower-cased: sort and audience (`_pub`)
 *      change the render id, never the shelf.
 *   3. Once per shelf per page entry (sort-tab switches re-mount the feed);
 *      leaving the page (registry destroy) re-arms it.
 *   4. The response is drained — this endpoint 401s by design without an
 *      identity, and an undrained body hangs network-idle.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn() },
  verbose: { debug: vi.fn(), content: vi.fn() },
}));
const drainResponse = vi.hoisted(() => vi.fn(async (r) => r));
vi.mock('../../../resources/js/utilities/drainResponse', () => ({ drainResponse }));

const UUID = '0b2c1f9e-4d3a-4e8b-9c1d-2a3b4c5d6e7f';

async function freshModule() {
  vi.resetModules();
  return await import('../../../resources/js/scrolling/pageViewTelemetry');
}

function postedPages() {
  return global.fetch.mock.calls.map(([, init]) => JSON.parse(init.body).page);
}

beforeEach(() => {
  drainResponse.mockClear();
  global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
  document.body.setAttribute('data-page', 'journal');
});

describe('recordShelfFeedView', () => {
  it('posts the shelf uuid for a shelf feed, and ignores other feeds', async () => {
    const m = await freshModule();
    m.recordShelfFeedView('most-recent');
    m.recordShelfFeedView('offline-books');
    m.recordShelfFeedView(`shelf_about_${UUID}`);
    expect(global.fetch).not.toHaveBeenCalled();

    m.recordShelfFeedView(`shelf_${UUID.toUpperCase()}_published_pub`);
    await Promise.resolve();
    expect(postedPages()).toEqual([`shelf:${UUID}`]);
    expect(global.fetch.mock.calls[0][0]).toBe('/api/database-to-indexeddb/page-view');
  });

  it('counts a shelf once per entry across sort and audience switches, re-armed by destroy', async () => {
    const m = await freshModule();
    m.recordShelfFeedView(`shelf_${UUID}_published_pub`);
    m.recordShelfFeedView(`shelf_${UUID}_connected_pub`);
    m.recordShelfFeedView(`shelf_${UUID}_lit`);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    m.destroyPageViewTelemetry();
    m.recordShelfFeedView(`shelf_${UUID}_published_pub`);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('drains the (routinely 401) response', async () => {
    const m = await freshModule();
    m.recordShelfFeedView(`shelf_${UUID}_published`);
    await vi.waitFor(() => expect(drainResponse).toHaveBeenCalledTimes(1));
  });

  it('does not post a home view on a non-home page', async () => {
    const m = await freshModule();
    m.initPageViewTelemetry();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

/**
 * Nominating a shelf's overview book from the owner's shelf view (server half:
 * tests/Feature/Api/ShelfOverviewTest.php). Pinned: it PATCHes the OPEN owned
 * shelf (the one shelfHeader stamped) with overview_book = the book, or null
 * to clear; with no owned shelf open it does nothing; a refusal surfaces and
 * reports false.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const tabs = vi.hoisted(() => ({ invalidateShelfCache: vi.fn(), openShelf: vi.fn(async () => {}) }));
const dialog = vi.hoisted(() => ({ alertDialog: vi.fn(async () => {}) }));
vi.mock('../../../resources/js/components/shelves/shelfTabs', () => tabs);
vi.mock('../../../resources/js/components/dialog/dialog', () => dialog);

import { setShelfOverview } from '../../../resources/js/components/shelves/shelfOverview';

const SHELF = '11111111-2222-4333-8444-555555555555';
const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('setShelfOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = `<div id="shelf-header" data-drop-shelf-id="${SHELF}" data-drop-shelf-name="Course"></div>`;
    globalThis.fetch = vi.fn(() => json({ success: true }));
  });

  it('PATCHes the open owned shelf with the book', async () => {
    expect(await setShelfOverview('book_intro')).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`/api/shelves/${SHELF}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ overview_book: 'book_intro' });
  });

  it('null clears it', async () => {
    await setShelfOverview(null);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ overview_book: null });
  });

  it('does nothing when no owned shelf is open', async () => {
    document.body.innerHTML = '<div id="shelf-header"></div>';
    expect(await setShelfOverview('book_intro')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('on the owner\'s archive page it PATCHes the archive\'s shelf and reloads', async () => {
    const seed = JSON.stringify({ shelfId: SHELF, name: 'Course' });
    document.body.innerHTML = `<div id="bottom-right-buttons" data-archive-edit='${seed}'></div>`;
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    expect(await setShelfOverview('book_intro')).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(`/api/shelves/${SHELF}`);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ overview_book: 'book_intro' });
    expect(reload).toHaveBeenCalled();
    expect(tabs.openShelf).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('a refusal reports false', async () => {
    fetch.mockImplementation(() => json({ error: 'Only a book on this shelf can be its overview.' }, 422));
    expect(await setShelfOverview('book_other')).toBe(false);
  });
});

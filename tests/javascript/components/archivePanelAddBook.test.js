/**
 * The archive panel's plus (keeper only) and the shelf target it sets
 * (utilities/newBookShelfTarget; server half: canAdd/addShelfId in
 * tests/Feature/ArchiveExport/ArchivePanelTest.php + ShelfOverviewTest.php).
 *
 * Pinned: the plus renders only with canAdd; the target is read ONCE; it ages
 * out; a real click on the ordinary New button clears it (the plus's own
 * click is synthetic and must not); adding POSTs the book to the shelf.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/bibtexProcessor', () => ({ formatBibtexToCitation: vi.fn(async () => 'A citation') }));

import { buildArchiveHtml } from '../../../resources/js/components/archivePanel/buildArchiveHtml';
import {
  setNewBookShelfTarget, takeNewBookShelfTarget, addBookToShelf,
} from '../../../resources/js/utilities/newBookShelfTarget';

const SHELF = '11111111-2222-4333-8444-555555555555';
const base = {
  displayName: 'Course', noun: 'archive', pageUrl: 'https://x.test/a/course', bibtex: '',
  librarian: { label: 'Kept by', name: 'sam', url: null }, audience: 'public', shelfId: SHELF,
  counts: { public_books: 2, export_books: 2, e2ee_skipped: 0 },
};

describe('archive panel plus', () => {
  beforeEach(() => { sessionStorage.clear(); document.body.innerHTML = ''; });

  it('renders only for the keeper', async () => {
    document.body.innerHTML = await buildArchiveHtml({ ...base });
    expect(document.getElementById('archive-add-book')).toBeNull();
    document.body.innerHTML = await buildArchiveHtml({ ...base, canAdd: true, addShelfId: SHELF });
    expect(document.getElementById('archive-add-book')).not.toBeNull();
  });

  it('the plus is an in-panel popover (Blank / Import) that blurs the panel, like Share', async () => {
    const { wirePanelPopover } = await import('../../../resources/js/components/sourceContainer/readerActions');
    document.body.innerHTML = `<div id="archive-container">${await buildArchiveHtml({ ...base, canAdd: true, addShelfId: SHELF })}</div>`;
    const container = document.getElementById('archive-container');
    const control = container.querySelector('#add-control');
    const picked = vi.fn();
    wirePanelPopover(container, control, control.querySelector('#archive-add-book'), (opt) => picked(opt.dataset.add));

    const panel = control.querySelector('.share-panel');
    expect(panel.style.display).toBe('none');
    control.querySelector('#archive-add-book').click();
    expect(panel.style.display).toBe('block');
    expect(control.classList.contains('share-open')).toBe(true); // drives the content blur
    expect([...panel.querySelectorAll('.share-option')].map((o) => o.dataset.add)).toEqual(['blank', 'import']);
    panel.querySelector('[data-add="import"]').click();
    expect(picked).toHaveBeenCalledWith('import');
    container.querySelector('.share-overlay').click(); // click on the blurred content closes it
    expect(panel.style.display).toBe('none');
  });

  it('the shelf target is read once', () => {
    setNewBookShelfTarget(SHELF);
    expect(takeNewBookShelfTarget()).toBe(SHELF);
    expect(takeNewBookShelfTarget()).toBeNull();
  });

  it('an old target is ignored', () => {
    sessionStorage.setItem('pending_new_book_shelf', JSON.stringify({ shelfId: SHELF, at: Date.now() - 60 * 60 * 1000 }));
    expect(takeNewBookShelfTarget()).toBeNull();
  });

  it('a REAL click on the New button clears it; the plus\'s synthetic click does not', () => {
    document.body.innerHTML = '<button id="newBookButton"></button>';
    const btn = document.getElementById('newBookButton');
    setNewBookShelfTarget(SHELF);
    btn.click(); // synthetic: isTrusted false
    expect(sessionStorage.getItem('pending_new_book_shelf')).not.toBeNull();
    const real = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(real, 'isTrusted', { value: true });
    btn.dispatchEvent(real);
    expect(sessionStorage.getItem('pending_new_book_shelf')).toBeNull();
  });

  it('adding POSTs the book to the shelf', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response('{"success":true}', { status: 200 })));
    expect(await addBookToShelf(SHELF, 'book_1')).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`/api/shelves/${SHELF}/items`);
    expect(JSON.parse(init.body)).toEqual({ book: 'book_1' });
  });
});

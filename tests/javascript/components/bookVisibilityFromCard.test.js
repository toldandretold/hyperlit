/**
 * Book visibility from a library CARD (server half:
 * tests/Feature/Api/ShelfBookVisibilityTest.php).
 *
 * Pinned:
 *   - the … menu's "Make public / Make private" item reads the card: the
 *     padlock class is the current state, an encrypted card never gets the
 *     item, and in a list that mixes owners (a shelf, an archive feed) only a
 *     card the owner render marked `libraryCard-own` does;
 *   - a flip goes through the ordinary library upsert and then patches EVERY
 *     rendered card for that book in place — the same padlock markup the
 *     server emits — and forgets each shelf tab's remembered render (the server
 *     flushed them);
 *   - a 200 is not a success: a refusal by the publish gate, or a stored
 *     visibility that did not change, leaves the card exactly as it was;
 *   - after a shelf goes public, the bulk question is asked only when the owner
 *     has something publishable, and "No" sends nothing; the mirror question is
 *     asked after a shelf goes private;
 *   - the bulk change is a LOOP of chunked calls following the server's cursor
 *     behind a progress dialog that is always taken down — one silent request
 *     for a 59-book shelf took 12s and was reloaded through;
 *   - refreshing a shelf forgets the remembered render on EVERY button for it,
 *     the archive page's per-sort feed buttons included.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const dialog = vi.hoisted(() => {
  const progress = { update: vi.fn(), close: vi.fn() };
  return {
    confirmDialog: vi.fn(async () => true),
    alertDialog: vi.fn(async () => {}),
    progressDialog: vi.fn(() => progress),
    progress,
  };
});
const tabs = vi.hoisted(() => ({ invalidateShelfCache: vi.fn(), openShelf: vi.fn(async () => {}) }));
const auth = vi.hoisted(() => ({ clearEditPermissionCache: vi.fn() }));
const prompts = vi.hoisted(() => ({ promptVerifyEmail: vi.fn(async () => {}), promptRegister: vi.fn(async () => {}) }));
const idb = vi.hoisted(() => {
  const records = new Map();
  // Just enough of IDBDatabase for the one get → put the mirror does.
  const openDatabase = async () => ({
    transaction() {
      const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
      tx.objectStore = () => ({
        get(key) {
          const req = { result: records.get(key), onsuccess: null };
          queueMicrotask(() => {
            req.onsuccess?.();
            queueMicrotask(() => tx.oncomplete?.());
          });
          return req;
        },
        put(record) {
          records.set(record.book, record);
        },
      });
      return tx;
    },
  });
  return { records, openDatabase };
});

vi.mock('../../../resources/js/components/dialog/dialog', () => dialog);
vi.mock('../../../resources/js/components/shelves/shelfTabs', () => tabs);
vi.mock('../../../resources/js/utilities/auth/index', () => auth);
vi.mock('../../../resources/js/utilities/auth/promptLogin', () => prompts);
vi.mock('../../../resources/js/indexedDB/index', () => ({ openDatabase: idb.openDatabase }));

import { bookVisibilityMenuItem } from '../../../resources/js/components/shelves/bookVisibilityMenuItem';
import {
  toggleBookVisibilityFromCard,
  offerToPublishShelfBooks,
  offerToUnpublishShelfBooks,
  refreshShelfTab,
} from '../../../resources/js/components/shelves/bookVisibility';

const SHELF = '11111111-2222-4333-8444-555555555555';
const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

/** A card as LibraryCardGenerator renders it. */
function cardHtml(book, { isPrivate = false, own = true, encrypted = false, feed = 'feed' } = {}) {
  const classes = ['libraryCard'];
  if (isPrivate) classes.push('libraryCard-private');
  if (encrypted) classes.push('libraryCard-encrypted');
  if (own) classes.push('libraryCard-own');
  return `<p class="${classes.join(' ')}" data-node-id="${feed}_${book}_card">`
    + `<span class="card-citation">Anon. ${book}</span>`
    + `<a href="/${book}"><span class="open-icon">↗</span></a>`
    + (isPrivate ? '<span class="private-icon"><svg></svg></span>' : '')
    + `<a href="#" class="book-actions" data-book="${book}">…</a></p>`;
}

const trigger = (book, feed = 'feed') => document.querySelector(`[data-node-id="${feed}_${book}_card"] .book-actions`);
const card = (book, feed = 'feed') => document.querySelector(`[data-node-id="${feed}_${book}_card"]`);

beforeEach(() => {
  vi.clearAllMocks();
  dialog.confirmDialog.mockResolvedValue(true);
  idb.records.clear();
  localStorage.clear();
  delete window.isUserPage;
  document.body.innerHTML = '';
  globalThis.fetch = vi.fn(() => json({ success: true, library: { visibility: 'private' } }));
});

describe('bookVisibilityMenuItem', () => {
  it('offers the opposite of what the card shows', () => {
    document.body.innerHTML = cardHtml('pub') + cardHtml('priv', { isPrivate: true });
    expect(bookVisibilityMenuItem(trigger('pub'), true)).toMatchObject({ id: 'make-private', label: 'Make private' });
    expect(bookVisibilityMenuItem(trigger('priv'), true)).toMatchObject({ id: 'make-public', label: 'Make public' });
  });

  it('never offers it on an encrypted card', () => {
    document.body.innerHTML = cardHtml('enc', { isPrivate: true, encrypted: true });
    expect(bookVisibilityMenuItem(trigger('enc'), true)).toBeNull();
    expect(bookVisibilityMenuItem(trigger('enc'), false)).toBeNull();
  });

  it('in a list that mixes owners, only a card marked as the owner\'s own gets it', () => {
    document.body.innerHTML = cardHtml('theirs', { own: false });
    expect(bookVisibilityMenuItem(trigger('theirs'), true)).toBeNull();
    // The Library lists only the owner's books, so it needs no mark.
    expect(bookVisibilityMenuItem(trigger('theirs'), false)).toMatchObject({ id: 'make-private' });
  });

  it('is null for a trigger outside any card', () => {
    document.body.innerHTML = '<a class="book-actions" data-book="x">…</a>';
    expect(bookVisibilityMenuItem(document.querySelector('.book-actions'), false)).toBeNull();
  });
});

describe('toggleBookVisibilityFromCard', () => {
  it('make private: upserts the visibility, then padlocks every rendered card for the book', async () => {
    document.body.innerHTML = `<div class="main-content">${cardHtml('b1', { feed: 'lib' })}${cardHtml('b2', { feed: 'lib' })}</div>`
      + `<div class="other">${cardHtml('b1', { feed: 'shelf' })}</div>`;

    expect(await toggleBookVisibilityFromCard('b1', false, trigger('b1', 'lib'))).toBe(true);

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/db/library/upsert');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.data).toMatchObject({ book: 'b1', visibility: 'private' });
    // A fresh clock — an old one reads as a stale write and the server no-ops.
    expect(body.data.timestamp).toBeGreaterThan(Date.now() - 5000);

    for (const feed of ['lib', 'shelf']) {
      const el = card('b1', feed);
      expect(el.classList.contains('libraryCard-private')).toBe(true);
      // The padlock sits where the server puts it: between the open link and the menu.
      expect(el.querySelector('.private-icon').nextElementSibling).toBe(trigger('b1', feed));
      expect(el.querySelectorAll('.private-icon')).toHaveLength(1);
    }
    expect(card('b2', 'lib').classList.contains('libraryCard-private')).toBe(false);
    expect(card('b2', 'lib').querySelector('.private-icon')).toBeNull();
  });

  it('make public: takes the padlock off', async () => {
    fetch.mockImplementation(() => json({ success: true, library: { visibility: 'public' } }));
    document.body.innerHTML = cardHtml('b1', { isPrivate: true });

    expect(await toggleBookVisibilityFromCard('b1', true, trigger('b1'))).toBe(true);

    expect(dialog.confirmDialog.mock.calls[0][0].title).toBe('Make this book public?');
    expect(card('b1').classList.contains('libraryCard-private')).toBe(false);
    expect(card('b1').querySelector('.private-icon')).toBeNull();
    expect(card('b1').querySelector('a[href="/b1"]')).not.toBeNull();
  });

  it('forgets every shelf tab\'s remembered render — the server flushed them', async () => {
    window.isUserPage = true;
    document.body.innerHTML = `<button class="arranger-button" data-filter="library" data-content="userAll">Library</button>`
      + `<button class="arranger-button shelf-tab" data-filter="shelf" data-shelf-id="${SHELF}" data-content="shelf_${SHELF}_recent">S</button>`
      + cardHtml('b1');

    await toggleBookVisibilityFromCard('b1', false, trigger('b1'));

    expect(document.querySelector('[data-filter="shelf"]').dataset.content).toBe('');
    expect(document.querySelector('[data-filter="library"]').dataset.content).toBe('userAll');
    expect(tabs.invalidateShelfCache).toHaveBeenCalled();
  });

  it('on the Library\'s Private filter, a book made public leaves the list', async () => {
    fetch.mockImplementation(() => json({ success: true, library: { visibility: 'public' } }));
    localStorage.setItem('user_library_filter', 'private');
    document.body.innerHTML = cardHtml('b1', { isPrivate: true }) + cardHtml('b2', { isPrivate: true });

    await toggleBookVisibilityFromCard('b1', true, trigger('b1'));

    expect(card('b1')).toBeNull();
    expect(card('b2')).not.toBeNull();
  });

  it('…but a shelf lists both visibilities, so the same flip there keeps the card', async () => {
    fetch.mockImplementation(() => json({ success: true, library: { visibility: 'public' } }));
    localStorage.setItem('user_library_filter', 'private');
    document.body.innerHTML = `<button class="arranger-button active" data-filter="shelf" data-shelf-id="${SHELF}" data-content="x">S</button>`
      + cardHtml('b1', { isPrivate: true });

    await toggleBookVisibilityFromCard('b1', true, trigger('b1'));

    expect(card('b1')).not.toBeNull();
    expect(card('b1').classList.contains('libraryCard-private')).toBe(false);
  });

  it('mirrors the change into a locally cached library record, and mints none for an uncached book', async () => {
    idb.records.set('b1', { book: 'b1', visibility: 'public', raw_json: { visibility: 'public', title: 'T' } });
    document.body.innerHTML = cardHtml('b1') + cardHtml('b2');

    await toggleBookVisibilityFromCard('b1', false, trigger('b1'));
    expect(idb.records.get('b1')).toMatchObject({ visibility: 'private', raw_json: { visibility: 'private', title: 'T' } });
    expect(auth.clearEditPermissionCache).toHaveBeenCalledWith('b1');

    await toggleBookVisibilityFromCard('b2', false, trigger('b2'));
    expect(idb.records.has('b2')).toBe(false);
  });

  it('cancelling the confirm sends nothing', async () => {
    dialog.confirmDialog.mockResolvedValue(false);
    document.body.innerHTML = cardHtml('b1');

    expect(await toggleBookVisibilityFromCard('b1', false, trigger('b1'))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(card('b1').classList.contains('libraryCard-private')).toBe(false);
  });

  it('an encrypted book is refused before any request', async () => {
    document.body.innerHTML = cardHtml('enc', { isPrivate: true, encrypted: true });

    expect(await toggleBookVisibilityFromCard('enc', true, trigger('enc'))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(dialog.alertDialog.mock.calls[0][0].title).toBe('This book is encrypted');
  });

  it('a publish-gate refusal is explained and the card keeps its padlock', async () => {
    fetch.mockImplementation(() => json({ success: true, publish_denied: 'unverified_email', library: { visibility: 'private' } }));
    document.body.innerHTML = cardHtml('b1', { isPrivate: true });

    expect(await toggleBookVisibilityFromCard('b1', true, trigger('b1'))).toBe(false);

    expect(dialog.confirmDialog.mock.calls[1][0].title).toBe('Verify your email to publish');
    expect(prompts.promptVerifyEmail).toHaveBeenCalled();
    expect(card('b1').classList.contains('libraryCard-private')).toBe(true);
    expect(card('b1').querySelector('.private-icon')).not.toBeNull();
  });

  it('a 200 whose stored visibility did not change is a failure, not a flip', async () => {
    // upsert answers 200 for a non-owner or a stale write.
    fetch.mockImplementation(() => json({ success: true, library: { visibility: 'public' } }));
    document.body.innerHTML = cardHtml('b1');

    expect(await toggleBookVisibilityFromCard('b1', false, trigger('b1'))).toBe(false);

    expect(dialog.alertDialog.mock.calls[0][0].title).toBe("Couldn't change visibility");
    expect(card('b1').classList.contains('libraryCard-private')).toBe(false);
  });

  it('a server error surfaces and changes nothing', async () => {
    fetch.mockImplementation(() => json({ message: 'Boom' }, 500));
    document.body.innerHTML = cardHtml('b1');

    expect(await toggleBookVisibilityFromCard('b1', false, trigger('b1'))).toBe(false);

    expect(dialog.alertDialog.mock.calls[0][0].message).toBe('Boom');
    expect(card('b1').classList.contains('libraryCard-private')).toBe(false);
  });
});

describe('offerToPublishShelfBooks', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(() => json({ success: true, published: 2, failed: 0, publish_denied: null }));
  });

  it('asks, and on Yes publishes through the shelf\'s bulk route', async () => {
    expect(await offerToPublishShelfBooks(SHELF, { own: 2, encrypted: 1, others: 0 })).toBe(2);

    const ask = dialog.confirmDialog.mock.calls[0][0];
    expect(ask.title).toBe('Make all books within this shelf public?');
    expect(ask.message).toContain('2 of your books');
    expect(ask.message).toContain('1 encrypted book stays private');

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`/api/shelves/${SHELF}/publish-books`);
    expect(init.method).toBe('POST');
  });

  it('No keeps them private and sends nothing', async () => {
    dialog.confirmDialog.mockResolvedValue(false);

    expect(await offerToPublishShelfBooks(SHELF, { own: 3, encrypted: 0, others: 0 })).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('with nothing of the owner\'s to publish there is no question — only a notice when books stay hidden', async () => {
    expect(await offerToPublishShelfBooks(SHELF, { own: 0, encrypted: 0, others: 2 })).toBe(0);
    expect(dialog.confirmDialog).not.toHaveBeenCalled();
    expect(dialog.alertDialog.mock.calls[0][0].title).toBe('Some books stay hidden');

    vi.clearAllMocks();
    expect(await offerToPublishShelfBooks(SHELF, { own: 0, encrypted: 0, others: 0 })).toBe(0);
    expect(dialog.confirmDialog).not.toHaveBeenCalled();
    expect(dialog.alertDialog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a publish-gate refusal publishes nothing and says why', async () => {
    fetch.mockImplementation(() => json({ success: false, published: 0, failed: 0, publish_denied: 'unverified_email' }));

    expect(await offerToPublishShelfBooks(SHELF, { own: 1, encrypted: 0, others: 0 })).toBe(0);
    expect(dialog.confirmDialog.mock.calls[1][0].title).toBe('Verify your email to publish');
  });

  it('reports a partial result instead of calling it done', async () => {
    fetch.mockImplementation(() => json({ success: true, published: 1, failed: 1, publish_denied: null }));

    expect(await offerToPublishShelfBooks(SHELF, { own: 2, encrypted: 0, others: 0 })).toBe(1);
    expect(dialog.alertDialog.mock.calls[0][0].title).toBe('Not every book was published');
  });

  it('follows the server\'s cursor chunk by chunk, showing how far it has got', async () => {
    const answers = [
      { success: true, published: 20, failed: 0, publish_denied: null, remaining: 39, next: 'book_20' },
      { success: true, published: 19, failed: 1, publish_denied: null, remaining: 19, next: 'book_40' },
      { success: true, published: 19, failed: 0, publish_denied: null, remaining: 0, next: null },
    ];
    fetch.mockImplementation(() => json(answers.shift()));

    expect(await offerToPublishShelfBooks(SHELF, { own: 59, encrypted: 0, others: 0 })).toBe(58);

    // Each call resumes from the cursor the last one handed back.
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([{}, { after: 'book_20' }, { after: 'book_40' }]);

    expect(dialog.progressDialog.mock.calls[0][0].message).toContain('0 of 59');
    expect(dialog.progress.update.mock.calls.map(([m]) => m.match(/^\d+ of \d+/)[0])).toEqual(['20 of 59', '40 of 59', '59 of 59']);
    expect(dialog.progress.close).toHaveBeenCalledTimes(1);
    // The one book that would not change is reported, not swallowed by the loop.
    expect(dialog.alertDialog.mock.calls[0][0].message).toContain('58 books are now public; 1 could not be changed');
  });

  it('a server that keeps handing back the same cursor cannot spin the page forever', async () => {
    fetch.mockImplementation(() => json({ success: true, published: 0, failed: 1, remaining: 1, next: 'stuck' }));

    await offerToPublishShelfBooks(SHELF, { own: 5, encrypted: 0, others: 0 });

    expect(fetch).toHaveBeenCalledTimes(2);   // the first, and the one that came back with the cursor it was sent
    expect(dialog.progress.close).toHaveBeenCalledTimes(1);
  });

  it('a chunk that fails mid-way takes the progress dialog down and says so', async () => {
    const answers = [
      () => json({ success: true, published: 20, failed: 0, remaining: 20, next: 'book_20' }),
      () => json({ error: 'Too Many Attempts.' }, 429),
    ];
    fetch.mockImplementation(() => answers.shift()());

    expect(await offerToPublishShelfBooks(SHELF, { own: 40, encrypted: 0, others: 0 })).toBe(0);

    expect(dialog.progress.close).toHaveBeenCalledTimes(1);
    const alert = dialog.alertDialog.mock.calls[0][0];
    expect(alert.title).toBe("Couldn't make the books public");
    expect(alert.message).toBe('Too Many Attempts.');
  });

  it('the publish gate stops the loop on the first call', async () => {
    fetch.mockImplementation(() => json({ success: false, published: 0, failed: 0, publish_denied: 'unverified_email', remaining: 0, next: null }));

    await offerToPublishShelfBooks(SHELF, { own: 30, encrypted: 0, others: 0 });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(dialog.progress.close).toHaveBeenCalledTimes(1);
  });
});

describe('offerToUnpublishShelfBooks', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(() => json({ success: true, unpublished: 2, failed: 0, remaining: 0, next: null }));
  });

  it('asks, and on Yes makes them private through the shelf\'s bulk route', async () => {
    expect(await offerToUnpublishShelfBooks(SHELF, { own: 2, others: 1 })).toBe(2);

    const ask = dialog.confirmDialog.mock.calls[0][0];
    expect(ask.title).toBe('Make all books within this shelf private?');
    expect(ask.message).toContain('2 of your books on this shelf are still public');
    expect(ask.message).toContain('1 book belongs to someone else and stays public either way');
    expect(ask.confirmLabel).toBe('Yes, make private');
    expect(ask.cancelLabel).toBe('No, keep public');

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`/api/shelves/${SHELF}/unpublish-books`);
    expect(init.method).toBe('POST');
    expect(dialog.progressDialog.mock.calls[0][0].title).toBe('Making books private…');
    expect(dialog.progress.close).toHaveBeenCalledTimes(1);
  });

  it('No leaves them public and sends nothing', async () => {
    dialog.confirmDialog.mockResolvedValue(false);

    expect(await offerToUnpublishShelfBooks(SHELF, { own: 3, others: 0 })).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(dialog.progressDialog).not.toHaveBeenCalled();
  });

  it('with nothing of the owner\'s public there is no question at all', async () => {
    expect(await offerToUnpublishShelfBooks(SHELF, { own: 0, others: 4 })).toBe(0);
    expect(dialog.confirmDialog).not.toHaveBeenCalled();
    expect(dialog.alertDialog).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('loops chunks like its mirror and reports a partial result', async () => {
    const answers = [
      { success: true, unpublished: 20, failed: 0, remaining: 5, next: 'book_20' },
      { success: true, unpublished: 4, failed: 1, remaining: 0, next: null },
    ];
    fetch.mockImplementation(() => json(answers.shift()));

    expect(await offerToUnpublishShelfBooks(SHELF, { own: 25, others: 0 })).toBe(24);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(dialog.alertDialog.mock.calls[0][0].title).toBe('Not every book was made private');
  });
});

describe('refreshShelfTab', () => {
  it('forgets the remembered render on every button for the shelf — archive feed buttons included', async () => {
    document.body.innerHTML = `
      <button class="arranger-button shelf-tab" data-filter="shelf" data-shelf-id="${SHELF}" data-sort="title" data-content="shelf_${SHELF}_title"></button>
      <button class="arranger-button" data-filter="shelf" data-shelf-id="${SHELF}" data-sort="published" data-content="shelf_${SHELF}_published_pub"></button>
      <button class="arranger-button active" data-filter="shelf" data-shelf-id="${SHELF}" data-sort="connected" data-content="shelf_${SHELF}_connected_pub"></button>
      <button class="arranger-button shelf-tab" data-filter="shelf" data-shelf-id="other-shelf" data-sort="recent" data-content="shelf_other_recent"></button>`;

    await refreshShelfTab(SHELF, 'My shelf', true);

    const contents = [...document.querySelectorAll(`[data-shelf-id="${SHELF}"]`)].map((b) => b.dataset.content);
    expect(contents).toEqual(['', '', '']);
    expect(document.querySelector('[data-shelf-id="other-shelf"]').dataset.content).toBe('shelf_other_recent');
    expect(tabs.invalidateShelfCache).toHaveBeenCalled();
    // Re-opened on the sort the reader is actually looking at.
    expect(tabs.openShelf).toHaveBeenCalledWith(SHELF, 'My shelf', 'connected');
  });

  it('without reopen it only forgets — the next activation fetches', async () => {
    document.body.innerHTML = `<button class="arranger-button shelf-tab" data-filter="shelf" data-shelf-id="${SHELF}" data-sort="title" data-content="x"></button>`;

    await refreshShelfTab(SHELF, 'My shelf', false);

    expect(document.querySelector('.shelf-tab').dataset.content).toBe('');
    expect(tabs.openShelf).not.toHaveBeenCalled();
  });
});

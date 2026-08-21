/**
 * Deleting a highlight must tear its sub-book's DOM down along with its store
 * (`hyperlights/deletion.ts` → `deleteHighlightById`).
 *
 * THE BUG THIS LOCKS: the delete emptied the sub-book from IndexedDB (and, via sync, from
 * Postgres) but left `.sub-book-content[data-book-id]` mounted in the container. The
 * integrity sweep that `closeHyperlitContainer` runs over every mounted sub-book then
 * compared that live DOM against the deliberately-emptied store and filed a mismatch
 * report — DOM 1 / IDB 0 / PG 0, "Missing from IDB" — for a deletion that had worked
 * perfectly. Nothing was actually wrong; the corpse DOM was the whole finding.
 *
 * The sweep bails early when it finds no node ids, so unmounting the sub-book IS the fix:
 * there is nothing left to compare. Verified here at the seam rather than through the
 * verifier, since that is where the corpse was being left behind.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const m = vi.hoisted(() => ({
  destroySubBook: vi.fn(),
  deleteBookFromIndexedDB: vi.fn().mockResolvedValue(undefined),
  queueForSync: vi.fn(),
  hyperlightRecord: null,
}));

vi.mock('../../../resources/js/hyperlitContainer/subBookActions', () => ({
  destroySubBook: m.destroySubBook,
}));
vi.mock('../../../resources/js/indexedDB/utilities/cleanup', () => ({
  deleteBookFromIndexedDB: m.deleteBookFromIndexedDB,
}));
vi.mock('../../../resources/js/indexedDB/index', () => ({
  openDatabase: vi.fn().mockResolvedValue({
    transaction: () => ({
      objectStore: () => ({
        index: () => ({
          get: () => {
            const req = {};
            setTimeout(() => { req.result = m.hyperlightRecord; req.onsuccess?.(); }, 0);
            return req;
          },
        }),
      }),
    }),
  }),
  updateBookTimestamp: vi.fn().mockResolvedValue(undefined),
  updateAnnotationsTimestamp: vi.fn().mockResolvedValue(undefined),
  queueForSync: m.queueForSync,
  getNodesFromIndexedDB: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../resources/js/hyperlights/database', () => ({
  removeHighlightFromHyperlights: vi.fn().mockResolvedValue(undefined),
  removeHighlightFromNodes: vi.fn().mockResolvedValue(undefined),
  removeHighlightFromNodesWithDeletion: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../resources/js/hyperlights/listeners', () => ({ attachMarkListeners: vi.fn() }));
vi.mock('../../../resources/js/hyperlitContainer/index', () => ({
  handleUnifiedContentClick: vi.fn(), initializeHyperlitManager: vi.fn(),
  openHyperlitContainer: vi.fn(), closeHyperlitContainer: vi.fn(),
}));
vi.mock('../../../resources/js/hyperlights/myHighlights/ghostLedger', () => ({
  renderGhostLedger: vi.fn(),
}));

import { deleteHighlightById } from '../../../resources/js/hyperlights/deletion';

const BOOK = 'book_123';
const HL = 'HL_456';
const SUB_BOOK = `${BOOK}/${HL}`;

/** Mount a sub-book exactly as subBookLoader does: .sub-book-content + data-book-id. */
function mountSubBookDom(subBookId) {
  const container = document.createElement('div');
  container.id = 'hyperlit-container';
  container.innerHTML = `
    <div class="highlight-annotation" data-highlight-id="${HL}">
      <div class="sub-book-content" data-book-id="${subBookId}">
        <div class="chunk"><p id="1" data-node-id="${subBookId}_n1">Testing…</p></div>
      </div>
    </div>`;
  document.body.appendChild(container);
  return container;
}

const mountedSubBooks = () =>
  [...document.querySelectorAll('.sub-book-content[data-book-id]')].map((el) => el.getAttribute('data-book-id'));

beforeEach(() => {
  document.body.innerHTML = '';
  m.destroySubBook.mockReset();
  m.deleteBookFromIndexedDB.mockReset().mockResolvedValue(undefined);
  m.queueForSync.mockReset();
  m.hyperlightRecord = { book: BOOK, hyperlight_id: HL, node_id: [], charData: {} };
});

afterEach(() => { document.body.innerHTML = ''; });

describe('deleteHighlightById — sub-book teardown', () => {
  it('destroys the sub-book loader for the deleted highlight', async () => {
    mountSubBookDom(SUB_BOOK);

    await deleteHighlightById(HL);

    expect(m.deleteBookFromIndexedDB).toHaveBeenCalledWith(SUB_BOOK);
    // Proper teardown, not a raw remove(): it also disconnects the lazy loader.
    expect(m.destroySubBook).toHaveBeenCalledWith(SUB_BOOK);
  });

  it('leaves no mounted sub-book DOM behind for the integrity sweep to trip on', async () => {
    mountSubBookDom(SUB_BOOK);
    expect(mountedSubBooks()).toEqual([SUB_BOOK]);

    await deleteHighlightById(HL);

    // destroySubBook is mocked here (its real impl removes containerDiv), so this asserts
    // the belt-and-braces DOM sweep — the path that covers a sub-book which was rendered
    // without ever registering with subBookLoader.
    expect(mountedSubBooks()).toEqual([]);
  });

  it('does not touch a DIFFERENT highlight\'s sub-book', async () => {
    mountSubBookDom(SUB_BOOK);
    const other = document.createElement('div');
    other.className = 'sub-book-content';
    other.setAttribute('data-book-id', `${BOOK}/HL_other`);
    document.getElementById('hyperlit-container').appendChild(other);

    await deleteHighlightById(HL);

    expect(mountedSubBooks()).toEqual([`${BOOK}/HL_other`]);
  });
});

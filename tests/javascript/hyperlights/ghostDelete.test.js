/**
 * Ghost-highlight delete → graveyard refresh (hyperlights/deletion.ts +
 * myHighlights/ghostLedger.ts).
 *
 * A GHOST has no marks in the DOM and (for the unplaceable ones the ledger
 * shows) no surviving nodes — deleteHighlightById must still remove the IDB
 * record, queue the server delete, and re-render the ghost ledger so the
 * graveyard entry disappears immediately.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installFreshIndexedDB, seedStore } from '../indexedDB/idbHarness';

// deletion.ts → ./listeners → hyperlitContainer/index breaks under happy-dom.
vi.mock('../../../resources/js/hyperlitContainer/index', () => ({
  handleUnifiedContentClick: vi.fn(), initializeHyperlitManager: vi.fn(),
  openHyperlitContainer: vi.fn(), closeHyperlitContainer: vi.fn(),
}));
vi.mock('../../../resources/js/scrolling/index', () => ({
  getCascadeOriginId: vi.fn(() => null),
}));
// Real openDatabase (fake-IDB harness); side-effecting sync/timestamp fns stubbed.
const queueForSync = vi.fn();
vi.mock('../../../resources/js/indexedDB/index', async () => {
  const { openDatabase } = await import('../../../resources/js/indexedDB/core/connection');
  return {
    openDatabase,
    updateBookTimestamp: vi.fn(async () => {}),
    updateAnnotationsTimestamp: vi.fn(async () => {}),
    getNodesFromIndexedDB: vi.fn(async () => []),
    queueForSync: (...args) => queueForSync(...args),
  };
});
vi.mock('../../../resources/js/indexedDB/utilities/cleanup', () => ({
  deleteBookFromIndexedDB: vi.fn(async () => {}),
}));
vi.mock('../../../resources/js/utilities/auth/index', () => ({
  getAuthContextSync: vi.fn(() => ({ user: null, userId: 'anon-1' })),
  getAuthContext: vi.fn(async () => ({ user: null, userId: 'anon-1' })),
}));

import { deleteHighlightById } from '../../../resources/js/hyperlights/deletion';
import { renderGhostLedger } from '../../../resources/js/hyperlights/myHighlights/ghostLedger';
import { openDatabase } from '../../../resources/js/indexedDB/core/connection';

const BOOK = 'book_ghost_delete';

function ghostRecord(id) {
  return {
    book: BOOK,
    hyperlight_id: id,
    node_id: ['nGone'],
    charData: { nGone: { charStart: -1, charEnd: -1 } }, // tombstone, node deleted
    highlightedText: 'the words that were deleted from the book',
    highlightedHTML: '<mark>the words that were deleted from the book</mark>',
    annotation: '',
    creator: null,
    creator_token: 'anon-1', // owned by the anon identity above
  };
}

async function recordExists(id) {
  const db = await openDatabase();
  return new Promise((resolve) => {
    const req = db.transaction('hyperlights', 'readonly').objectStore('hyperlights').index('hyperlight_id').getKey(id);
    req.onsuccess = () => resolve(req.result !== undefined);
    req.onerror = () => resolve(false);
  });
}

describe('deleting a ghost highlight', () => {
  beforeEach(() => {
    installFreshIndexedDB();
    queueForSync.mockClear();
    document.body.innerHTML = `
      <div class="reader-content-wrapper">
        <main id="${BOOK}" class="main-content"></main>
      </div>`;
  });

  it('removes the record, queues the server delete, and clears the graveyard entry', async () => {
    await seedStore('hyperlights', [ghostRecord('HL_ghost_del'), ghostRecord('HL_ghost_keep')]);

    // The graveyard shows both unplaceable ghosts.
    await renderGhostLedger(BOOK);
    expect(document.querySelectorAll('.ghost-ledger-mark')).toHaveLength(2);

    const result = await deleteHighlightById('HL_ghost_del');
    expect(result.success).toBe(true);

    // IDB record gone + server delete queued with the record payload.
    expect(await recordExists('HL_ghost_del')).toBe(false);
    expect(queueForSync).toHaveBeenCalledWith(
      'hyperlights', 'HL_ghost_del', 'delete',
      expect.objectContaining({ hyperlight_id: 'HL_ghost_del' }),
    );

    // The ledger refresh is fire-and-forget — poll for the re-render.
    await vi.waitFor(() => {
      const ids = [...document.querySelectorAll('.ghost-ledger-mark')]
        .map((el) => el.getAttribute('data-highlight-id'));
      expect(ids).toEqual(['HL_ghost_keep']);
    });
  });

  it('deleting the LAST ghost removes the graveyard section entirely', async () => {
    await seedStore('hyperlights', [ghostRecord('HL_only')]);
    await renderGhostLedger(BOOK);
    expect(document.getElementById('ghost-ledger')).toBeTruthy();

    await deleteHighlightById('HL_only');

    await vi.waitFor(() => {
      expect(document.getElementById('ghost-ledger')).toBeNull();
    });
  });
});

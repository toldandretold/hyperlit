/**
 * Characterization net for the citation-management handlers — pinned BEFORE the
 * displayHypercites.ts → displayHypercites/ folder split. Imports via the stable barrel
 * specifier so this file is invariant across the refactor. Dynamic-import targets (../utils,
 * ../core, ../../hyperlights/index, ../../utilities/BroadcastListener) are mocked at their
 * resolved resources/js paths, which don't change when the source moves into the subfolder.
 *
 * Pins: handleManageCitationsClick button injection (health-check always; delete only when
 * canUserEditBook); handleHyperciteHealthCheck delete-enable state machine (IDB-hit keeps delete
 * disabled; not-found enables it); handleHyperciteDelete → removeSpecificCitations mutating
 * citedIN + relationshipStatus + the node's embedded copy, read back from IDB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFreshIndexedDB, seedStore, readOne } from '../indexedDB/idbHarness.js';

vi.mock('../../../resources/js/app', () => ({ book: 'bookA' }));
vi.mock('../../../resources/js/indexedDB/index', async () => {
  const conn = await vi.importActual('../../../resources/js/indexedDB/core/connection');
  return {
    openDatabase: conn.openDatabase,
    queueForSync: vi.fn(),
    debouncedMasterSync: { flush: vi.fn().mockResolvedValue(undefined) },
    updateBookTimestamp: vi.fn().mockResolvedValue(true),
  };
});
vi.mock('dompurify', () => ({ default: { sanitize: (s) => s } }));
vi.mock('../../../resources/js/utilities/bibtexProcessor', () => ({ formatBibtexToCitation: vi.fn(async (b) => b) }));
vi.mock('../../../resources/js/utilities/auth/index', () => ({ canUserEditBook: vi.fn() }));
vi.mock('../../../resources/js/components/toast/toast', () => ({ showTargetNotFoundToast: vi.fn() }));
vi.mock('../../../resources/js/hyperlitContainer/utils', () => ({ fetchLibraryFromServer: vi.fn().mockResolvedValue(null) }));
vi.mock('../../../resources/js/hyperlitContainer/core', () => ({ closeHyperlitContainer: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../resources/js/hyperlights/index', () => ({ reprocessHighlightsForNodes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../resources/js/utilities/BroadcastListener', () => ({ broadcastToOpenTabs: vi.fn() }));

import {
  handleManageCitationsClick,
  handleHyperciteHealthCheck,
  handleHyperciteDelete,
} from '../../../resources/js/hyperlitContainer/contentBuilders/displayHypercites';
import { canUserEditBook } from '../../../resources/js/utilities/auth/index';
import { queueForSync } from '../../../resources/js/indexedDB/index';
import { closeHyperlitContainer } from '../../../resources/js/hyperlitContainer/core';

const tag = (id) => `<a id="${id}">x</a>`;
const evt = (currentTarget) => ({ currentTarget, preventDefault() {}, stopPropagation() {} });

describe('hypercite citation management (characterization)', () => {
  let fetchMock;
  beforeEach(() => {
    installFreshIndexedDB();
    document.head.innerHTML = '<meta name="csrf-token" content="test-csrf">';
    document.body.innerHTML = '';
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('alert', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function seedManagementDom() {
    document.body.innerHTML = `
      <div class="hypercites-section">
        <div></div>
        <span class="hypercite-management-buttons"
              data-book-id="bookB"
              data-citation-url="/bookB#hypercite_1"
              data-hypercite-id="hypercite_1"
              data-source-hypercite-id="hypercite_src"
              data-content-type="node"
              data-content-item-id=""
              data-sub-book-id=""></span>
      </div>`;
  }

  it('handleManageCitationsClick injects a health-check button always, delete only with edit access', async () => {
    canUserEditBook.mockResolvedValue(true);
    await seedStore('nodes', [{ book: 'bookB', startLine: 100, chunk_id: 0, content: tag('hypercite_1') }]);
    seedManagementDom();

    await handleManageCitationsClick(evt(document.createElement('div')));

    const hc = document.querySelector('.hypercite-health-check-btn');
    expect(hc).toBeTruthy();
    expect(hc.getAttribute('data-citing-book')).toBe('bookB');
    expect(hc.getAttribute('data-hypercite-id')).toBe('hypercite_1');
    expect(document.querySelector('.hypercite-delete-btn')).toBeTruthy(); // edit access → delete injected
  });

  it('handleManageCitationsClick WITHOUT edit access → no delete button', async () => {
    canUserEditBook.mockResolvedValue(false);
    await seedStore('nodes', [{ book: 'bookB', startLine: 100, chunk_id: 0, content: tag('hypercite_1') }]);
    seedManagementDom();

    await handleManageCitationsClick(evt(document.createElement('div')));

    expect(document.querySelector('.hypercite-health-check-btn')).toBeTruthy();
    expect(document.querySelector('.hypercite-delete-btn')).toBeFalsy();
  });

  it('handleHyperciteHealthCheck: IDB hit keeps delete disabled; not-found enables it', async () => {
    document.body.innerHTML = `
      <div>
        <button class="hypercite-health-check-btn" data-citing-book="bookB" data-hypercite-id="hypercite_1"
                data-content-type="node" data-content-item-id="" data-sub-book-id=""><svg></svg></button>
        <button class="hypercite-delete-btn" disabled></button>
      </div>`;
    const btn = document.querySelector('.hypercite-health-check-btn');
    const del = document.querySelector('.hypercite-delete-btn');

    // Hit: seed the node containing the hypercite id
    await seedStore('nodes', [{ book: 'bookB', startLine: 100, chunk_id: 0, content: tag('hypercite_1') }]);
    await handleHyperciteHealthCheck(evt(btn));
    expect(del.disabled).toBe(true);
    expect(btn.title).toContain('bookB:100');
    expect(fetchMock).not.toHaveBeenCalled();

    // Not-found: fresh DOM + empty DB → PG fallback returns no nodes → delete enabled
    installFreshIndexedDB();
    document.body.innerHTML = `
      <div>
        <button class="hypercite-health-check-btn" data-citing-book="bookB" data-hypercite-id="hypercite_1"
                data-content-type="node" data-content-item-id="" data-sub-book-id=""><svg></svg></button>
        <button class="hypercite-delete-btn" disabled></button>
      </div>`;
    const btn2 = document.querySelector('.hypercite-health-check-btn');
    const del2 = document.querySelector('.hypercite-delete-btn');
    await handleHyperciteHealthCheck(evt(btn2));
    expect(del2.disabled).toBe(false);
    expect(btn2.title).toContain('not found');
  });

  it('handleHyperciteDelete → removeSpecificCitations prunes citedIN, transitions status, syncs the node copy', async () => {
    await seedStore('hypercites', [{
      book: 'bookA', hyperciteId: 'hypercite_1', hypercitedText: 't',
      citedIN: ['/citingbook#hcX', '/other#hcY'], relationshipStatus: 'poly', node_id: [],
    }]);
    await seedStore('nodes', [{
      book: 'bookA', startLine: 100, chunk_id: 0, content: 'x',
      hypercites: [{ hyperciteId: 'hypercite_1', citedIN: ['/citingbook#hcX', '/other#hcY'], relationshipStatus: 'poly' }],
    }]);

    const del = document.createElement('button');
    del.setAttribute('data-source-book', 'bookA');
    del.setAttribute('data-source-hypercite-id', 'hypercite_1');
    del.setAttribute('data-citation-url', '/citingbook#hcX');

    await handleHyperciteDelete(evt(del));

    const hyp = await readOne('hypercites', ['bookA', 'hypercite_1']);
    expect(hyp.citedIN).toEqual(['/other#hcY']);
    expect(hyp.relationshipStatus).toBe('couple'); // 2 → 1 left

    const node = await readOne('nodes', ['bookA', 100]);
    expect(node.hypercites[0].citedIN).toEqual(['/other#hcY']);

    expect(queueForSync).toHaveBeenCalledWith('hypercites', 'hypercite_1', 'update', expect.anything());
    expect(queueForSync).toHaveBeenCalledWith('nodes', 100, 'update', expect.anything());
    expect(closeHyperlitContainer).toHaveBeenCalled();
  });
});

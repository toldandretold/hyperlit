/**
 * Characterization net for checkHyperciteExists (the health-check engine) — pinned BEFORE the
 * displayHypercites.ts → displayHypercites/ folder split. Imports via the stable barrel
 * specifier so this file is invariant across the refactor.
 *
 * Pins the {exists, chunkKey} contract across the node / footnote / hyperlight branches, the
 * IndexedDB-hit vs PostgreSQL-fallback paths, and footnote active-vs-orphaned.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFreshIndexedDB, seedStore } from '../indexedDB/idbHarness.js';

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

import { checkHyperciteExists } from '../../../resources/js/hyperlitContainer/contentBuilders/displayHypercites';

const ID = 'hypercite_1';
const tag = (id) => `<a id="${id}">x</a>`;

describe('checkHyperciteExists (characterization)', () => {
  let fetchMock;
  beforeEach(() => {
    installFreshIndexedDB();
    document.head.innerHTML = '<meta name="csrf-token" content="test-csrf">';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('node hit in IndexedDB → {exists, chunkKey: "book:startLine"}', async () => {
    await seedStore('nodes', [{ book: 'bookB', startLine: 100, chunk_id: 0, content: tag(ID) }]);
    expect(await checkHyperciteExists('bookB', ID, 'node')).toEqual({ exists: true, chunkKey: 'bookB:100' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('node not in IndexedDB → PostgreSQL fallback (only when no local chunks)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ nodes: [{ startLine: 50, content: tag(ID) }] }) });
    expect(await checkHyperciteExists('bookB', ID, 'node')).toEqual({ exists: true, chunkKey: 'bookB:50' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('node present but no match (indexedDBOnly) → {exists:false}', async () => {
    await seedStore('nodes', [{ book: 'bookB', startLine: 100, chunk_id: 0, content: '<p>no match</p>' }]);
    expect(await checkHyperciteExists('bookB', ID, 'node', null, '', true)).toEqual({ exists: false, chunkKey: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('footnote: content has the hypercite AND the footnote is still active in a node → exists', async () => {
    await seedStore('footnotes', [{ book: 'bookB', footnoteId: 'Fn1', content: tag(ID) }]);
    await seedStore('nodes', [{ book: 'bookB', startLine: 100, chunk_id: 0, content: 'x', footnotes: ['Fn1'] }]);
    expect(await checkHyperciteExists('bookB', ID, 'footnote', 'Fn1', '', true))
      .toEqual({ exists: true, chunkKey: 'bookB:footnote:Fn1' });
  });

  it('footnote: content has it but the footnote is NOT active in any node → {exists:false}', async () => {
    await seedStore('footnotes', [{ book: 'bookB', footnoteId: 'Fn1', content: tag(ID) }]);
    await seedStore('nodes', [{ book: 'bookB', startLine: 100, chunk_id: 0, content: 'x', footnotes: [] }]);
    expect(await checkHyperciteExists('bookB', ID, 'footnote', 'Fn1', '', true))
      .toEqual({ exists: false, chunkKey: null });
  });

  it('hyperlight: annotation contains the hypercite → exists', async () => {
    await seedStore('hyperlights', [{ book: 'bookB', hyperlight_id: 'HL_1', annotation: tag(ID) }]);
    expect(await checkHyperciteExists('bookB', ID, 'hyperlight', 'HL_1', '', true))
      .toEqual({ exists: true, chunkKey: 'bookB:hyperlight:HL_1' });
  });

  it('nothing anywhere (indexedDBOnly) → {exists:false}', async () => {
    expect(await checkHyperciteExists('bookB', ID, 'node', null, '', true)).toEqual({ exists: false, chunkKey: null });
  });
});

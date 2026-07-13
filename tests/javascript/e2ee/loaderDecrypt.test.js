/**
 * Download seam (docs/e2ee.md): encrypted server payloads come back to
 * PLAINTEXT IndexedDB rows through every loader, and plaintext payloads pass
 * through untouched (even with no vault at all). Covers serverSync/loaders
 * (nodes/footnotes/bibliography/hyperlights/hypercites/library) and the
 * separate lazyLoader/chunkFetcher path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// loadLibraryToIndexedDB syncs the gate-filter cache — irrelevant here.
vi.mock('../../../resources/js/components/utilities/gateFilter', () => ({
  setBookGateDefaults: vi.fn(),
  appendGateParam: (url) => url,
}));

import { installFreshIndexedDB, seedStore, readOne, readAll } from '../indexedDB/idbHarness.js';
import { openDatabase } from '../../../resources/js/indexedDB/core/connection';
import {
  loadNodesToIndexedDB,
  loadFootnotesToIndexedDB,
  loadBibliographyToIndexedDB,
  loadHyperlightsToIndexedDB,
  loadHypercitesToIndexedDB,
  loadLibraryToIndexedDB,
} from '../../../resources/js/indexedDB/serverSync/loaders';
import { storeSingleChunkToIndexedDB } from '../../../resources/js/lazyLoader/chunkFetcher';
import { createVault, createDekForBook, getDekForBook, clearKeyCaches } from '../../../resources/js/e2ee/keys';
import { isBookEncrypted, clearEncryptedBookRegistry } from '../../../resources/js/e2ee/registry';
import { encryptString, decryptString } from '../../../resources/js/e2ee/crypto';
import { wrapJsonEnvelope } from '../../../resources/js/e2ee/envelope';

const ENC = 'encbook';

let dek;
let wrappedDek;

async function env(value) {
  return encryptString(typeof value === 'string' ? value : JSON.stringify(value), dek, ENC);
}

beforeEach(async () => {
  installFreshIndexedDB();
  clearKeyCaches();
  clearEncryptedBookRegistry();
  await createVault();
  ({ wrappedDek } = await createDekForBook(ENC));
  await seedStore('library', [{ book: ENC, encrypted: true, wrapped_dek: wrappedDek }]);
  dek = await getDekForBook(ENC);
});

describe('decrypt-on-download', () => {
  it('loadNodesToIndexedDB stores plaintext rows and blanks server-built views', async () => {
    const db = await openDatabase();
    const wireNode = {
      book: ENC,
      startLine: '100',
      chunk_id: 0,
      node_id: 'n1',
      content: await env('<p>SECRET body</p>'),
      footnotes: wrapJsonEnvelope(await env([{ id: 'fn1', marker: '1' }])),
      // Server "rebuilt" these from ciphertext charData — garbage by construction
      hyperlights: [{ highlightID: 'hl1', annotation: 'hlenc.v1.AAAA.BBBB', charStart: null, charEnd: null }],
      hypercites: [],
    };

    await loadNodesToIndexedDB(db, [wireNode]);

    const stored = await readOne('nodes', [ENC, 100]);
    expect(stored.content).toBe('<p>SECRET body</p>');
    expect(stored.footnotes).toEqual([{ id: 'fn1', marker: '1' }]);
    // Broken server views dropped (local rebuild owns these arrays)
    expect(stored.hyperlights).toEqual([]);
    expect(stored.hypercites).toEqual([]);
  });

  it('chunkFetcher.storeSingleChunkToIndexedDB decrypts the lazy-load path too', async () => {
    await storeSingleChunkToIndexedDB([{
      book: ENC,
      startLine: '200',
      chunk_id: 2,
      node_id: 'n2',
      content: await env('<p>SECRET lazy</p>'),
      footnotes: null,
      hyperlights: [],
      hypercites: [],
    }]);

    const stored = await readOne('nodes', [ENC, 200]);
    expect(stored.content).toBe('<p>SECRET lazy</p>');
  });

  it('footnotes / bibliography / annotation loaders round-trip to plaintext', async () => {
    const db = await openDatabase();

    await loadFootnotesToIndexedDB(db, {
      book: ENC,
      data: { fn1: { content: await env('<p>SECRET foot</p>'), preview_nodes: null } },
    });
    expect((await readOne('footnotes', [ENC, 'fn1'])).content).toBe('<p>SECRET foot</p>');

    await loadBibliographyToIndexedDB(db, {
      book: ENC,
      data: { r1: { content: await env('SECRET ref'), source_id: 'src1' } },
    });
    const ref = await readOne('bibliography', [ENC, 'r1']);
    expect(ref.content).toBe('SECRET ref');
    expect(ref.source_id).toBe('src1'); // structural fields untouched

    await loadHyperlightsToIndexedDB(db, [{
      book: ENC,
      hyperlight_id: 'hl1',
      node_id: ['n1'],
      annotation: await env('SECRET note'),
      highlightedText: await env('SECRET text'),
      highlightedHTML: await env('<b>SECRET text</b>'),
      charData: wrapJsonEnvelope(await env({ n1: { charStart: 1, charEnd: 4 } })),
    }]);
    const hl = await readOne('hyperlights', [ENC, 'hl1']);
    expect(hl.annotation).toBe('SECRET note');
    expect(hl.charData).toEqual({ n1: { charStart: 1, charEnd: 4 } });

    await loadHypercitesToIndexedDB(db, [{
      book: ENC,
      hyperciteId: 'hc1',
      node_id: ['n1'],
      relationshipStatus: 'single',
      hypercitedText: await env('SECRET cite'),
      hypercitedHTML: await env('<i>SECRET cite</i>'),
      citedIN: wrapJsonEnvelope(await env(['bk9'])),
      charData: {},
    }]);
    const hc = await readOne('hypercites', [ENC, 'hc1']);
    expect(hc.hypercitedText).toBe('SECRET cite');
    expect(hc.citedIN).toEqual(['bk9']);
  });

  it('loadLibraryToIndexedDB bootstraps the DEK from the row itself and stores plaintext metadata', async () => {
    // Fresh device simulation: no library record yet, only the vault key persists.
    installFreshIndexedDB();
    clearEncryptedBookRegistry();
    clearKeyCaches();
    await createVault();
    const { wrappedDek: freshWrapped } = await createDekForBook(ENC);
    const freshDek = await getDekForBook(ENC);
    clearKeyCaches(); // drop DEK cache; vault persists in the NEW db? No — createVault re-persisted it.

    const db = await openDatabase();
    await loadLibraryToIndexedDB(db, {
      book: ENC,
      encrypted: true,
      wrapped_dek: freshWrapped,
      title: await encryptString('SECRET title', freshDek, ENC),
      author: await encryptString('SECRET author', freshDek, ENC),
      timestamp: 42,
      gate_defaults: null,
    });

    const stored = await readOne('library', ENC);
    expect(stored.title).toBe('SECRET title');
    expect(stored.author).toBe('SECRET author');
    expect(stored.encrypted).toBe(true);
    expect(stored.wrapped_dek).toBe(freshWrapped);
    expect(stored.base_timestamp).toBe(42);
    // Registry populated for the sync emitters
    expect(isBookEncrypted(ENC)).toBe(true);
  });

  it('plaintext payloads pass through untouched — no vault required at all', async () => {
    installFreshIndexedDB();
    clearEncryptedBookRegistry();
    clearKeyCaches(); // no vault, no keys — the public-reader case

    const db = await openDatabase();
    await loadNodesToIndexedDB(db, [{
      book: 'public-book',
      startLine: '1',
      chunk_id: 0,
      node_id: 'p1',
      content: '<p>plain body</p>',
      footnotes: null,
      hyperlights: [{ highlightID: 'h', annotation: 'note', charStart: 0, charEnd: 2 }],
      hypercites: [],
    }]);

    const stored = await readOne('nodes', ['public-book', 1]);
    expect(stored.content).toBe('<p>plain body</p>');
    expect(stored.hyperlights).toHaveLength(1); // server views KEPT for plaintext books
  });
});

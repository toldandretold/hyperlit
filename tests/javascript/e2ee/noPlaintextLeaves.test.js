/**
 * THE E2EE PROOF SUITE (docs/e2ee.md): for an encrypted book, NO plaintext ever
 * leaves the client on ANY sync route. Every emitter is driven for real
 * (real queue → master sync → fetch; real IDB via fake-indexeddb; real crypto)
 * with fetch/sendBeacon captured, then every captured body is deep-scanned for
 * sentinel strings planted in every content field.
 *
 * Emitters covered here:
 *   1. queueForSync → debouncedMasterSync → POST /api/db/unified-sync
 *   2. syncIndexedDBtoPostgreSQLBlocking (same choke point, blocking entry)
 *   3. syncNodesToPostgreSQL → POST /api/db/nodes/targeted-upsert
 *   4. push.ts syncIndexedDBtoPostgreSQL → the per-store upsert endpoints
 *   5. syncOnUnload → navigator.sendBeacon (outbox substitution + skip-and-retain)
 * (subBookLoader's previewContent seam is exercised in e2e — importing it here
 * would drag the whole lazyLoader/pageLoad graph into a unit test.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/auth', () => ({
  refreshCsrfToken: vi.fn(),
}));
vi.mock('../../../resources/js/components/editIndicator.js', () => ({
  glowCloudOrange: vi.fn(),
}));
vi.mock('../../../resources/js/utilities/BroadcastListener', () => ({
  showStaleTabOverlay: vi.fn(),
}));
vi.mock('../../../resources/js/integrity/reporter', () => ({
  reportIntegrityFailure: vi.fn(),
  reportServerError: vi.fn(),
}));

import { installFreshIndexedDB, seedStore, waitFor } from '../indexedDB/idbHarness.js';
import {
  debouncedMasterSync,
  initMasterSyncDependencies,
  syncIndexedDBtoPostgreSQLBlocking,
  executeSyncPayload,
  __resetSyncConcurrencyStateForTests,
} from '../../../resources/js/indexedDB/syncQueue/master';
import {
  queueForSync,
  pendingSyncs,
  initSyncQueueDependencies,
} from '../../../resources/js/indexedDB/syncQueue/queue';
import { setupUnloadSync, initUnloadSyncDependencies } from '../../../resources/js/indexedDB/syncQueue/unload';
import { syncNodesToPostgreSQL } from '../../../resources/js/indexedDB/nodes/syncNodesToPostgreSQL';
import { syncIndexedDBtoPostgreSQL } from '../../../resources/js/indexedDB/serverSync/push';
import { createVault, createDekForBook, clearKeyCaches, lockVault } from '../../../resources/js/e2ee/keys';
import { setBookEncrypted, clearEncryptedBookRegistry } from '../../../resources/js/e2ee/registry';
import { clearBeaconOutbox, beaconOutboxSize } from '../../../resources/js/e2ee/outbox';

const ENC = 'encbook';
const PLAIN = 'plainbook';
const ENVELOPE = /^hlenc\.v1\./;

function makeNode(book, startLine, sentinel) {
  return {
    book,
    startLine,
    chunk_id: 0,
    node_id: `${book}_${startLine}_x`,
    content: `<p>${sentinel} body</p>`,
    hyperlights: [{ highlightID: 'hl1', annotation: `${sentinel} note`, charStart: 0, charEnd: 3 }],
    hypercites: [],
    footnotes: [{ id: 'fn1', marker: '1' }],
  };
}

/** Every request body captured by the fetch/sendBeacon mocks, as text. */
async function capturedBodies(fetchMock, beaconMock) {
  const bodies = [];
  for (const call of fetchMock.mock.calls) {
    const body = call[1]?.body;
    if (typeof body === 'string') bodies.push({ url: call[0], text: body });
  }
  for (const call of beaconMock.mock.calls) {
    const blob = call[1];
    if (blob) bodies.push({ url: call[0], text: await blob.text() });
  }
  return bodies;
}

describe('E2EE proof: no plaintext leaves the client for an encrypted book', () => {
  let fetchMock;
  let beaconMock;

  beforeEach(async () => {
    installFreshIndexedDB();
    pendingSyncs.clear();
    clearBeaconOutbox();
    clearKeyCaches();
    clearEncryptedBookRegistry();
    __resetSyncConcurrencyStateForTests();
    sessionStorage.removeItem('pending_new_book_sync');
    document.head.innerHTML = '<meta name="csrf-token" content="test-csrf-token">';
    document.body.innerHTML = `<div class="main-content" id="${ENC}"></div>`;

    initMasterSyncDependencies({
      book: ENC,
      getInitialBookSyncPromise: () => null,
    });
    initSyncQueueDependencies({ debouncedMasterSync });
    initUnloadSyncDependencies({ book: ENC });

    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
    beaconMock = vi.fn().mockReturnValue(true);
    navigator.sendBeacon = beaconMock;

    // Vault + encrypted book with sentinel-bearing content everywhere
    await createVault();
    const { wrappedDek } = await createDekForBook(ENC);
    await seedStore('library', [{
      book: ENC,
      encrypted: true,
      wrapped_dek: wrappedDek,
      title: 'SECRET title',
      author: 'SECRET author',
      timestamp: 5,
      base_timestamp: 5,
    }]);
    setBookEncrypted(ENC, true);
  });

  afterEach(() => {
    debouncedMasterSync.cancel?.();
    vi.unstubAllGlobals();
  });

  async function assertNoSentinelLeaked() {
    const bodies = await capturedBodies(fetchMock, beaconMock);
    expect(bodies.length).toBeGreaterThan(0);
    for (const { url, text } of bodies) {
      expect(text, `plaintext sentinel leaked to ${url}`).not.toContain('SECRET');
    }
    return bodies;
  }

  it('1+2. unified sync (queued edit AND blocking full sync) sends only ciphertext', async () => {
    await seedStore('nodes', [makeNode(ENC, 100, 'SECRET')]);
    await seedStore('hyperlights', [{
      book: ENC, hyperlight_id: 'hl1', node_id: [`${ENC}_100_x`],
      charData: { [`${ENC}_100_x`]: { charStart: 0, charEnd: 3 } },
      annotation: 'SECRET annotation', highlightedText: 'SECRET text', highlightedHTML: '<b>SECRET text</b>',
    }]);

    // Live-edit route: queue + flush the debounce
    queueForSync('nodes', 100, 'update', makeNode(ENC, 100, 'SECRET'));
    debouncedMasterSync.flush?.();
    await waitFor(() => fetchMock.mock.calls.length >= 1);

    // Blocking route (same choke point, different entry)
    await syncIndexedDBtoPostgreSQLBlocking(ENC);

    const bodies = await assertNoSentinelLeaked();
    for (const { text } of bodies) {
      const payload = JSON.parse(text);
      expect(payload.book).toBe(ENC);
      for (const node of payload.nodes ?? []) {
        if (node._action) continue;
        expect(node.content).toMatch(ENVELOPE);
        expect(node.startLine).toBeTypeOf('number'); // structural fields stay usable
        expect('plainText' in node).toBe(false);
      }
      if (payload.library) expect(payload.library.title).toMatch(ENVELOPE);
    }
  });

  it('3. targeted upsert sends only ciphertext', async () => {
    const result = await syncNodesToPostgreSQL(ENC, [makeNode(ENC, 100, 'SECRET')]);
    expect(result.success).toBe(true);

    const bodies = await assertNoSentinelLeaked();
    const payload = JSON.parse(bodies[0].text);
    expect(bodies[0].url).toBe('/api/db/nodes/targeted-upsert');
    expect(payload.data[0].content).toMatch(ENVELOPE);
  });

  it('4. full-book push encrypts EVERY per-store endpoint', async () => {
    await seedStore('nodes', [makeNode(ENC, 100, 'SECRET')]);
    await seedStore('hyperlights', [{
      book: ENC, hyperlight_id: 'hl1', node_id: ['n1'], charData: {},
      annotation: 'SECRET a', highlightedText: 'SECRET t', highlightedHTML: '<i>SECRET t</i>',
    }]);
    await seedStore('hypercites', [{
      book: ENC, hyperciteId: 'hc1', node_id: ['n1'], charData: {}, citedIN: [],
      relationshipStatus: 'single', hypercitedText: 'SECRET q', hypercitedHTML: '<i>SECRET q</i>',
    }]);
    await seedStore('footnotes', [{ book: ENC, footnoteId: 'fn1', content: '<p>SECRET f</p>' }]);
    await seedStore('bibliography', [{ book: ENC, referenceId: 'r1', content: 'SECRET bib' }]);

    await syncIndexedDBtoPostgreSQL(ENC);

    const bodies = await assertNoSentinelLeaked();
    const urls = bodies.map((b) => b.url);
    expect(urls).toContain('/api/db/nodes/upsert');
    expect(urls).toContain('/api/db/library/upsert');
    expect(urls).toContain('/api/db/hyperlights/upsert');
  });

  it('5. beacon substitutes outbox ciphertext and RETAINS uncaptured items', async () => {
    setupUnloadSync();

    // Item A: queue, let the outbox capture settle
    queueForSync('nodes', 100, 'update', makeNode(ENC, 100, 'SECRET'));
    debouncedMasterSync.cancel?.(); // beacon path only — don't let the debounce race
    await waitFor(() => beaconOutboxSize() === 1);

    // Item B: queue and IMMEDIATELY unload — capture cannot have settled
    queueForSync('nodes', 101, 'update', makeNode(ENC, 101, 'SECRET'));
    debouncedMasterSync.cancel?.();
    window.dispatchEvent(new Event('pagehide'));

    expect(beaconMock).toHaveBeenCalledTimes(1);
    const bodies = await capturedBodies(fetchMock, beaconMock);
    const beaconBody = JSON.parse(bodies[bodies.length - 1].text);
    expect(bodies[bodies.length - 1].text).not.toContain('SECRET');
    expect(beaconBody.updates.nodes).toHaveLength(1);
    expect(beaconBody.updates.nodes[0].content).toMatch(ENVELOPE);
    expect(beaconBody.updates.nodes[0].startLine).toBe(100);
    // The uncaptured item stays queued instead of ever riding as plaintext
    expect(pendingSyncs.size).toBe(1);
    expect([...pendingSyncs.keys()][0]).toContain('-101');
  });

  it('refuses to sync at all while the vault is locked (fail closed, plaintext never a fallback)', async () => {
    await lockVault(); // registry still says encrypted; keys are gone
    await expect(syncNodesToPostgreSQL(ENC, [makeNode(ENC, 100, 'SECRET')])).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('control: a plaintext book syncs byte-identically to its input (seam is a no-op)', async () => {
    const node = makeNode(PLAIN, 100, 'HELLO');
    await executeSyncPayload({
      book: PLAIN,
      updates: { nodes: [node], hypercites: [], hyperlights: [], footnotes: [], bibliography: [], library: null },
      deletions: { nodes: [], hypercites: [], hyperlights: [], footnotes: [], bibliography: [] },
    });

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.nodes[0].content).toBe('<p>HELLO body</p>');
    expect(payload.nodes[0].hyperlights[0].annotation).toBe('HELLO note');
  });
});

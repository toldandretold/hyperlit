/**
 * serverSync/loaders — write server payloads into the IndexedDB stores.
 *
 * Pure store-writers used by the pull path (pull.ts), the initial-chunk
 * loader and the background downloader. Split out of the former
 * resources/js/postgreSQL.js.
 */
import { parseNodeId, prepareLibraryForIndexedDB } from '../index';
import { verbose } from '../../utilities/logger';
// E2EE seam (docs/e2ee.md): registry is a zero-import leaf; the transform/keys
// modules load on demand. Decryption is envelope-detected (self-describing), so
// plaintext books pass through at the cost of a prefix check per field.
import { setBookEncrypted } from '../../e2ee/registry';
import type { NodeRecord, NodeHyperlightView, FootnoteRecord, BibliographyRecord, HyperciteRecord, HyperlightRecord } from '../types';
import { asChunkId } from '../types';
import type {
  ServerNodeRow,
  ServerHyperlightRow,
  ServerHyperciteRow,
  ServerFootnotesPayload,
  ServerBibliographyPayload,
  ServerLibraryRow,
} from './types';

/**
 * E2EE decrypt gate: returns the rows decrypted when any carries an hlenc
 * envelope, or the input array untouched. MUST run before any IDB transaction
 * opens (an await inside an open tx auto-commits it). Throws VaultLockedError
 * when ciphertext is present but the vault key is unavailable.
 */
async function decryptIfEnveloped<T extends Record<string, unknown>>(store: string, rows: T[]): Promise<{ rows: T[]; hadEnvelopes: boolean }> {
  if (!rows.length) return { rows, hadEnvelopes: false };
  const { rowHasEnvelopes, decryptRows } = await import('../../e2ee/transform');
  if (!rows.some((row) => rowHasEnvelopes(store, row))) {
    return { rows, hadEnvelopes: false };
  }
  return { rows: await decryptRows(store, rows), hadEnvelopes: true };
}

/**
 * Write items to an IndexedDB store in batches, yielding between each batch
 * to prevent blocking user interactions with long-held readwrite locks.
 */
async function batchedWrite<T>(
  db: IDBDatabase,
  storeName: string,
  items: T[],
  processItem: ((item: T) => unknown) | null = null,
  batchSize = 100,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);

    for (const item of batch) {
      const record = processItem ? processItem(item) : item;
      store.put(record);
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Yield to main thread between batches so user interactions can interleave
    if (i + batchSize < items.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}

/**
 * Load nodes into IndexedDB
 */
export async function loadNodesToIndexedDB(db: IDBDatabase, nodes: ServerNodeRow[] | undefined): Promise<NodeRecord[]> {
  if (!nodes || nodes.length === 0) {
    verbose.content('No nodes to load', 'serverSync/loaders');
    return [];
  }

  verbose.content(`Loading ${nodes.length} nodes`, 'serverSync/loaders');

  let chunksWithHighlights = 0;
  let userHighlightCount = 0;

  function processNode(chunk: ServerNodeRow): NodeRecord {
    let parsedHyperlights: unknown[] | null = null;
    if (chunk.hyperlights) {
      try {
        parsedHyperlights = typeof chunk.hyperlights === 'string' ?
          JSON.parse(chunk.hyperlights) : chunk.hyperlights;

        if (parsedHyperlights && parsedHyperlights.length > 0) {
          chunksWithHighlights++;
          userHighlightCount += parsedHyperlights.filter((h) => (h as { is_user_highlight?: boolean }).is_user_highlight).length;
        }
      } catch (parseError) {
        console.error('❌ Error parsing hyperlights:', parseError);
        parsedHyperlights = [];
      }
    }

    // Normalize the annotation arrays to [] (never null): NodeRecord declares them
    // as arrays, and every reader already guards null/[] identically — so honoring
    // the array contract here is safe and makes processNode genuinely produce a
    // NodeRecord. The `as NodeHyperlightView[]` is the wire→storage boundary
    // assertion (the server embeds hyperlights in the rendered-view shape).
    return {
      ...chunk,
      startLine: parseNodeId(chunk.startLine),
      chunk_id: asChunkId(chunk.chunk_id),
      footnotes: (typeof chunk.footnotes === 'string' ?
        (chunk.footnotes ? JSON.parse(chunk.footnotes) : null) : chunk.footnotes) ?? [],
      hypercites: (typeof chunk.hypercites === 'string' ?
        (chunk.hypercites ? JSON.parse(chunk.hypercites) : null) : chunk.hypercites) ?? [],
      hyperlights: (parsedHyperlights ?? []) as NodeHyperlightView[],
    };
  }

  // E2EE: decrypt BEFORE the write transactions. Server-rebuilt embedded
  // annotation views are unusable for encrypted books (the server built them
  // from ciphertext charData) — blank them and rebuild from the local
  // (decrypted) hyperlights/hypercites stores after the write.
  const processed = nodes.map(processNode);
  const { rows: records, hadEnvelopes } = await decryptIfEnveloped(
    'nodes',
    processed as unknown as Record<string, unknown>[],
  );
  const finalRecords = records as unknown as NodeRecord[];
  if (hadEnvelopes) {
    for (const record of finalRecords) {
      record.hyperlights = [];
      record.hypercites = [];
    }
  }

  await batchedWrite(db, 'nodes', finalRecords, null, 100);

  if (hadEnvelopes) {
    // Best-effort local rebuild (annotations may still be loading in parallel
    // on first pull — the render path's own rebuildNodeArrays pass covers that).
    try {
      const { rebuildNodeArrays } = await import('../hydration/rebuild');
      await rebuildNodeArrays(finalRecords);
    } catch (rebuildError) {
      verbose.content(`Post-decrypt rebuild skipped: ${(rebuildError as Error).message}`, 'serverSync/loaders');
    }
  }

  verbose.content(`Loaded ${nodes.length} nodes (${chunksWithHighlights} with highlights, ${userHighlightCount} user highlights)`, 'serverSync/loaders');

  // Return the DECRYPTED, processed records so callers (fetchInitialChunk) can render from
  // plaintext. The input `nodes` (raw server rows) stays ciphertext for an encrypted book —
  // returning it as window.nodes rendered hlenc.v1 blobs (empty content) on fresh-device load.
  return finalRecords;
}

/**
 * Load footnotes into IndexedDB
 */
export async function loadFootnotesToIndexedDB(db: IDBDatabase, footnotes: ServerFootnotesPayload | null | undefined): Promise<void> {
  if (!footnotes || !footnotes.data) {
    verbose.content('No footnotes to load', 'serverSync/loaders');
    return;
  }

  // Convert footnotes.data object to individual records (before any tx — the
  // E2EE decrypt below awaits, which would auto-commit an open transaction).
  const footnotesData = footnotes.data;
  const records: FootnoteRecord[] = [];

  for (const [footnoteId, footnoteData] of Object.entries(footnotesData)) {
    // Inline the type guard (not a boolean var) so TS narrows footnoteData to the
    // object form inside the true branch and to string in the false branch.
    const isNewFormat = typeof footnoteData === 'object' && footnoteData !== null;
    records.push({
      book:          footnotes.book,
      footnoteId:    footnoteId,
      content:       isNewFormat ? (footnoteData.content ?? '') : footnoteData,
      preview_nodes: isNewFormat ? (footnoteData.preview_nodes ?? null) : null,
    });
  }

  const { rows: finalRecords } = await decryptIfEnveloped(
    'footnotes',
    records as unknown as Record<string, unknown>[],
  );

  const tx = db.transaction('footnotes', 'readwrite');
  const store = tx.objectStore('footnotes');
  const promises = (finalRecords as unknown as FootnoteRecord[]).map(
    (record) => new Promise<void>((resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }),
  );

  await Promise.all(promises);

  verbose.content(`Loaded ${Object.keys(footnotesData).length} footnotes`, 'serverSync/loaders');
}

/**
 * Load bibliography/references into IndexedDB
 */
export async function loadBibliographyToIndexedDB(db: IDBDatabase, bibliography: ServerBibliographyPayload | null | undefined): Promise<void> {
  if (!bibliography || !bibliography.data) {
    verbose.content('No bibliography to load', 'serverSync/loaders');
    return;
  }

  // Convert bibliography.data object to individual records (before any tx —
  // the E2EE decrypt below awaits, which would auto-commit an open transaction).
  const bibliographyData = bibliography.data;
  const records: BibliographyRecord[] = [];

  for (const [referenceId, refData] of Object.entries(bibliographyData)) {
    // Handle both formats:
    // - New format: { content: '...', source_id: '...' }
    // - Legacy format: just the content string (from old EPUB imports)
    const isNewFormat = typeof refData === 'object' && refData !== null;

    records.push({
      book: bibliography.book,
      referenceId: referenceId,
      content: isNewFormat ? refData.content : refData,
      source_id: isNewFormat ? (refData.source_id || null) : null,
      canonical_source_id: isNewFormat ? (refData.canonical_source_id || null) : null,
      source_has_nodes: isNewFormat ? (refData.source_has_nodes ?? null) : null,
      source_is_web_stub: isNewFormat ? (refData.source_is_web_stub ?? null) : null,
      source_external_url: isNewFormat ? (refData.source_external_url ?? null) : null,
      reference_match_method: isNewFormat ? (refData.reference_match_method ?? null) : null,
      reference_verified_at: isNewFormat ? (refData.reference_verified_at ?? null) : null,
    });
  }

  const { rows: finalRecords } = await decryptIfEnveloped(
    'bibliography',
    records as unknown as Record<string, unknown>[],
  );

  const tx = db.transaction('bibliography', 'readwrite');
  const store = tx.objectStore('bibliography');
  const promises = (finalRecords as unknown as BibliographyRecord[]).map(
    (record) => new Promise<void>((resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }),
  );

  await Promise.all(promises);

  verbose.content(`Loaded ${Object.keys(bibliographyData).length} references`, 'serverSync/loaders');
}

/**
 * Load hyperlights into IndexedDB
 */
export async function loadHyperlightsToIndexedDB(db: IDBDatabase, hyperlights: ServerHyperlightRow[] | undefined): Promise<void> {
  if (!hyperlights || hyperlights.length === 0) {
    verbose.content('No hyperlights to load', 'serverSync/loaders');
    return;
  }

  verbose.content(`Loading ${hyperlights.length} standalone hyperlights`, 'serverSync/loaders');

  let userHighlightCount = 0;
  let anonHighlightCount = 0;
  hyperlights.forEach((highlight) => {
    if (highlight.is_user_highlight) {
      userHighlightCount++;
    } else {
      anonHighlightCount++;
    }
  });

  // Normalize the wire row into a store record (mirror processHypercite): node_id may arrive
  // stringified — parse it to a string[] (the store/rebuild assume an array); guarantee book/charData.
  function processHyperlight(hl: ServerHyperlightRow): HyperlightRecord {
    return {
      ...hl,
      book: hl.book!,
      node_id: Array.isArray(hl.node_id) ? hl.node_id : JSON.parse((hl.node_id as string) || '[]'),
      charData: hl.charData ?? {},
      highlightedText: hl.highlightedText ?? '',
      highlightedHTML: hl.highlightedHTML ?? '',
      annotation: hl.annotation ?? '',
      raw_json: typeof hl.raw_json === 'string' ? JSON.parse(hl.raw_json) : hl.raw_json,
    };
  }

  const { rows: hyperlightRecords } = await decryptIfEnveloped(
    'hyperlights',
    hyperlights.map(processHyperlight) as unknown as Record<string, unknown>[],
  );
  await batchedWrite(db, 'hyperlights', hyperlightRecords, null, 100);

  verbose.content(`Loaded ${hyperlights.length} standalone hyperlights (${userHighlightCount} user, ${anonHighlightCount} anonymous)`, 'serverSync/loaders');
}

/**
 * Load hypercites into IndexedDB
 */
export async function loadHypercitesToIndexedDB(db: IDBDatabase, hypercites: ServerHyperciteRow[] | undefined): Promise<void> {
  if (!hypercites || hypercites.length === 0) {
    verbose.content('No hypercites to load', 'serverSync/loaders');
    return;
  }

  verbose.content(`Loading ${hypercites.length} hypercites`, 'serverSync/loaders');

  function processHypercite(hypercite: ServerHyperciteRow): HyperciteRecord {
    const citedIN = typeof hypercite.citedIN === 'string' ? JSON.parse(hypercite.citedIN) : hypercite.citedIN;
    return {
      ...hypercite,
      book: hypercite.book!,
      // node_id may arrive stringified — normalize to a string[] (the store/rebuild assume an array).
      node_id: Array.isArray(hypercite.node_id) ? hypercite.node_id : JSON.parse((hypercite.node_id as string) || '[]'),
      charData: hypercite.charData ?? {},
      citedIN: citedIN ?? [],
      relationshipStatus: hypercite.relationshipStatus ?? 'single',
      raw_json: typeof hypercite.raw_json === 'string' ? JSON.parse(hypercite.raw_json) : hypercite.raw_json,
    };
  }

  const { rows: hyperciteRecords } = await decryptIfEnveloped(
    'hypercites',
    hypercites.map(processHypercite) as unknown as Record<string, unknown>[],
  );
  await batchedWrite(db, 'hypercites', hyperciteRecords, null, 100);

  verbose.content(`Loaded ${hypercites.length} hypercites`, 'serverSync/loaders');
}

/**
 * Load library data into IndexedDB
 */
export async function loadLibraryToIndexedDB(db: IDBDatabase, library: ServerLibraryRow | null | undefined): Promise<void> {
  if (!library) {
    verbose.content('No library data to load', 'serverSync/loaders');
    return;
  }

  // E2EE bootstrap: the encrypted flag + wrapped DEK ride the library row —
  // record the flag (the emitters' isBookEncrypted check keys off it) and cache
  // the DEK BEFORE decrypting (the IDB library record getDekForBook reads may
  // not exist yet on first download).
  const wireRow = library as { book: string; encrypted?: boolean; wrapped_dek?: string | null };
  setBookEncrypted(wireRow.book, wireRow.encrypted === true);
  if (wireRow.encrypted && wireRow.wrapped_dek) {
    const { ensureDekFromWrapped } = await import('../../e2ee/keys');
    await ensureDekFromWrapped(wireRow.book, wireRow.wrapped_dek);
  }
  const { rows: decryptedRows } = await decryptIfEnveloped(
    'library',
    [library as unknown as Record<string, unknown>],
  );

  // 🧹 Clean the library data from PostgreSQL to remove any corrupted/bloated fields
  // This prevents corrupted data from propagating into IndexedDB
  const cleanedLibrary = prepareLibraryForIndexedDB(decryptedRows[0] as unknown as ServerLibraryRow);

  // Record the server version we just pulled as the optimistic-concurrency base.
  // The server's 409 stale check compares against THIS — local edits bump `timestamp` but
  // must never touch `base_timestamp`, so the server can detect "you edited an old version".
  cleanedLibrary.base_timestamp = (library.timestamp ?? cleanedLibrary.timestamp) as number | undefined;

  const tx = db.transaction('library', 'readwrite');
  const store = tx.objectStore('library');

  await new Promise<void>((resolve, reject) => {
    const request = store.put(cleanedLibrary);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

  // Keep the gate filter's book-level defaults cache in sync
  const { setBookGateDefaults } = await import('../../components/utilities/gateFilter');
  setBookGateDefaults(library.gate_defaults || null);

  verbose.content('Loaded library data (cleaned)', 'serverSync/loaders');
}

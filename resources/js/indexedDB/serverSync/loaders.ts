/**
 * serverSync/loaders — write server payloads into the IndexedDB stores.
 *
 * Pure store-writers used by the pull path (pull.ts), the initial-chunk
 * loader and the background downloader. Split out of the former
 * resources/js/postgreSQL.js.
 */
import { parseNodeId, prepareLibraryForIndexedDB } from '../index';
import { verbose } from '../../utilities/logger';
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
export async function loadNodesToIndexedDB(db: IDBDatabase, nodes: ServerNodeRow[] | undefined): Promise<void> {
  if (!nodes || nodes.length === 0) {
    verbose.content('No nodes to load', 'serverSync/loaders');
    return;
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
      raw_json: typeof chunk.raw_json === 'string' ?
        (chunk.raw_json ? JSON.parse(chunk.raw_json) : null) : chunk.raw_json
    };
  }

  await batchedWrite(db, 'nodes', nodes, processNode, 100);

  verbose.content(`Loaded ${nodes.length} nodes (${chunksWithHighlights} with highlights, ${userHighlightCount} user highlights)`, 'serverSync/loaders');
}

/**
 * Load footnotes into IndexedDB
 */
export async function loadFootnotesToIndexedDB(db: IDBDatabase, footnotes: ServerFootnotesPayload | null | undefined): Promise<void> {
  if (!footnotes || !footnotes.data) {
    verbose.content('No footnotes to load', 'serverSync/loaders');
    return;
  }

  const tx = db.transaction('footnotes', 'readwrite');
  const store = tx.objectStore('footnotes');

  // Convert footnotes.data object to individual records
  const footnotesData = footnotes.data;
  const promises: Promise<void>[] = [];

  for (const [footnoteId, footnoteData] of Object.entries(footnotesData)) {
    // Inline the type guard (not a boolean var) so TS narrows footnoteData to the
    // object form inside the true branch and to string in the false branch.
    const isNewFormat = typeof footnoteData === 'object' && footnoteData !== null;
    const record: FootnoteRecord = {
      book:          footnotes.book,
      footnoteId:    footnoteId,
      content:       isNewFormat ? (footnoteData.content ?? '') : footnoteData,
      preview_nodes: isNewFormat ? (footnoteData.preview_nodes ?? null) : null,
    };

    promises.push(new Promise<void>((resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }));
  }

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

  const tx = db.transaction('bibliography', 'readwrite');
  const store = tx.objectStore('bibliography');

  // Convert bibliography.data object to individual records
  const bibliographyData = bibliography.data;
  const promises: Promise<void>[] = [];

  for (const [referenceId, refData] of Object.entries(bibliographyData)) {
    // Handle both formats:
    // - New format: { content: '...', source_id: '...' }
    // - Legacy format: just the content string (from old EPUB imports)
    const isNewFormat = typeof refData === 'object' && refData !== null;

    const record: BibliographyRecord = {
      book: bibliography.book,
      referenceId: referenceId,
      content: isNewFormat ? refData.content : refData,
      source_id: isNewFormat ? (refData.source_id || null) : null,
      canonical_source_id: isNewFormat ? (refData.canonical_source_id || null) : null,
      source_has_nodes: isNewFormat ? (refData.source_has_nodes ?? null) : null,
    };

    promises.push(new Promise<void>((resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }));
  }

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

  await batchedWrite(db, 'hyperlights', hyperlights, processHyperlight, 100);

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

  await batchedWrite(db, 'hypercites', hypercites, processHypercite, 100);

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

  // 🧹 Clean the library data from PostgreSQL to remove any corrupted/bloated fields
  // This prevents corrupted data from propagating into IndexedDB
  const cleanedLibrary = prepareLibraryForIndexedDB(library);

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

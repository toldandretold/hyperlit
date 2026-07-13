/**
 * E2EE payload transforms — encrypt outbound rows / decrypt inbound rows for
 * every store that carries user content. This module is THE single list of
 * which fields are content-bearing per table; the sync emitters and loaders
 * call these instead of knowing about fields themselves.
 *
 * Encryption is per field: strings become `hlenc.v1....` envelopes, JSON
 * fields become `{"__hlenc__": "hlenc.v1...."}` (keeps jsonb columns
 * object-shaped). Structural fields (book, startLine, chunk_id, node_id,
 * ids, timestamps, `_action` deletion markers) stay plaintext by design.
 *
 * Decryption is self-describing (envelope detection), so it runs
 * unconditionally on the download path and no-ops on plaintext books.
 */

import { isEnvelope, isJsonEnvelope, wrapJsonEnvelope, unwrapJsonEnvelope } from './envelope';
import { encryptString, decryptString } from './crypto';
import { getDekForBook } from './keys';
import { rootBookId } from './registry';

interface FieldSpec {
  /** Fields encrypted as bare string envelopes (text columns). */
  strings: readonly string[];
  /** Fields JSON-stringified then enveloped as {__hlenc__} (jsonb columns). */
  json: readonly string[];
}

/**
 * Content-bearing fields per store/wire shape. Matches the client record
 * types in indexedDB/types.ts (PublicNode / *Record) — server column names
 * where they differ travel through the same keys on the wire.
 */
export const FIELD_SPECS: Record<string, FieldSpec> = {
  nodes: {
    strings: ['content'],
    // Embedded render views (hyperlights[].annotation, citations[].text,
    // footnote markers) are user content too — envelope the whole array.
    json: ['hyperlights', 'hypercites', 'footnotes', 'citations'],
  },
  hyperlights: {
    strings: ['annotation', 'highlightedText', 'highlightedHTML'],
    json: ['charData', 'preview_nodes', 'raw_json'],
  },
  hypercites: {
    strings: ['hypercitedText', 'hypercitedHTML'],
    json: ['charData', 'citedIN', 'raw_json'],
  },
  footnotes: {
    strings: ['content'],
    json: ['preview_nodes'],
  },
  bibliography: {
    strings: ['content'],
  json: [],
  },
  library: {
    strings: [
      'title', 'author', 'bibtex', 'note', 'abstract', 'journal', 'pages',
      'publisher', 'school', 'url', 'year', 'fileName', 'volume', 'issue',
      'booktitle', 'chapter', 'editor',
    ],
    json: ['raw_json'],
  },
};

type Row = Record<string, unknown>;

/** Does this row carry at least one enveloped content field for its store? */
export function rowHasEnvelopes(store: string, rowInput: object): boolean {
  const row = rowInput as Row;
  const spec = FIELD_SPECS[store];
  if (!spec) return false;
  return (
    spec.strings.some((f) => isEnvelope(row[f])) ||
    spec.json.some((f) => isJsonEnvelope(row[f]))
  );
}

/**
 * Encrypt one row's content fields in place-of (returns a shallow clone;
 * the caller's IDB record is never mutated). Idempotent: already-enveloped
 * fields are left alone, so an emitter meeting outbox-encrypted data is safe.
 * Node rows also drop any `plainText` (the server must not receive it).
 */
export async function encryptRecordForStore<T extends object>(
  store: string,
  row: T,
  dek: CryptoKey,
  aad: string,
): Promise<T> {
  const spec = FIELD_SPECS[store];
  if (!spec) return row;

  const out: Row = { ...(row as Row) };

  for (const field of spec.strings) {
    const value = out[field];
    if (typeof value === 'string' && value !== '' && !isEnvelope(value)) {
      out[field] = await encryptString(value, dek, aad);
    }
  }
  for (const field of spec.json) {
    const value = out[field];
    if (value !== undefined && value !== null && !isJsonEnvelope(value)) {
      out[field] = wrapJsonEnvelope(await encryptString(JSON.stringify(value), dek, aad));
    }
  }
  if (store === 'nodes' && 'plainText' in out) {
    delete out.plainText;
  }
  return out as T;
}

/** Decrypt one row's content fields (shallow clone). Non-envelope fields untouched. */
export async function decryptRecordForStore<T extends object>(
  store: string,
  row: T,
  dek: CryptoKey,
  aad: string,
): Promise<T> {
  const spec = FIELD_SPECS[store];
  if (!spec) return row;

  const out: Row = { ...(row as Row) };

  for (const field of spec.strings) {
    const value = out[field];
    if (isEnvelope(value)) {
      out[field] = await decryptString(value, dek, aad);
    }
  }
  for (const field of spec.json) {
    const value = out[field];
    if (isJsonEnvelope(value)) {
      out[field] = JSON.parse(await decryptString(unwrapJsonEnvelope(value), dek, aad));
    }
  }
  return out as T;
}

/**
 * Encrypt outbound rows for one store. `bookId` may be the row's own (sub-)book;
 * the DEK and AAD always resolve to the ROOT book. Throws VaultLockedError when
 * the vault key is unavailable — callers must not send plaintext as a fallback.
 */
export async function encryptStoreRows<T extends object>(
  store: string,
  bookId: string,
  rows: T[],
): Promise<T[]> {
  if (!rows.length) return rows;
  const aad = rootBookId(bookId);
  const dek = await getDekForBook(bookId);
  return Promise.all(rows.map((row) => encryptRecordForStore(store, row, dek, aad)));
}

/** Convenience alias for the node emitters. */
export function encryptNodes<T extends object>(bookId: string, nodes: T[]): Promise<T[]> {
  return encryptStoreRows('nodes', bookId, nodes);
}

/**
 * Decrypt inbound rows for one store. Runs unconditionally: rows without
 * envelopes pass through at the cost of a prefix check per field; the DEK is
 * only fetched (and the vault only required) when a row actually carries
 * ciphertext. Rows may span books — the DEK resolves per row.
 */
export async function decryptRows<T extends object>(store: string, rows: T[]): Promise<T[]> {
  const out: T[] = [];
  const deks = new Map<string, CryptoKey>();

  for (const row of rows) {
    if (!rowHasEnvelopes(store, row)) {
      out.push(row);
      continue;
    }
    const root = rootBookId(String((row as Row).book ?? ''));
    let dek = deks.get(root);
    if (!dek) {
      dek = await getDekForBook(root);
      deks.set(root, dek);
    }
    out.push(await decryptRecordForStore(store, row, dek, root));
  }
  return out;
}

/**
 * Structural shape of the /api/db/unified-sync body (UnifiedSyncPayload in
 * indexedDB/types.ts). Declared structurally here so the transform layer
 * never imports from syncQueue (master.ts imports US — see the de-cycle rule).
 */
interface UnifiedPayloadShape {
  book: string;
  nodes?: object[];
  hypercites?: object[];
  hyperlights?: object[];
  hyperlightDeletions?: object[];
  footnotes?: object[];
  footnoteDeletions?: object[];
  bibliography?: object[];
  bibliographyDeletions?: object[];
  library?: object | null;
}

/** Section → field-spec store for the unified payload. */
const UNIFIED_SECTIONS: ReadonlyArray<[keyof UnifiedPayloadShape & string, string]> = [
  ['nodes', 'nodes'],
  ['hypercites', 'hypercites'],
  ['hyperlights', 'hyperlights'],
  ['hyperlightDeletions', 'hyperlights'],
  ['footnotes', 'footnotes'],
  ['footnoteDeletions', 'footnotes'],
  ['bibliography', 'bibliography'],
  ['bibliographyDeletions', 'bibliography'],
];

/**
 * Encrypt a whole unified-sync payload (the master.ts choke point). Deletion
 * rows keep their `_action` marker plaintext; only spec'd content fields on
 * them are enveloped (usually they carry none).
 */
export async function encryptUnifiedPayload<T extends UnifiedPayloadShape>(payload: T): Promise<T> {
  const aad = rootBookId(payload.book);
  const dek = await getDekForBook(payload.book);
  const out: Row = { ...(payload as unknown as Row) };

  for (const [section, store] of UNIFIED_SECTIONS) {
    const rows = out[section] as Row[] | undefined;
    if (Array.isArray(rows) && rows.length) {
      out[section] = await Promise.all(rows.map((row) => encryptRecordForStore(store, row, dek, aad)));
    }
  }
  if (out.library) {
    out.library = await encryptRecordForStore('library', out.library as Row, dek, aad);
  }
  return out as unknown as T;
}

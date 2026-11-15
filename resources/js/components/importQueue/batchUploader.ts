// Batch uploader: turn an IngestPlan's bundles into one import batch — the
// manifest is registered first (POST /api/import-batches, so the widget shows
// every item immediately as pending_upload), then files upload SEQUENTIALLY,
// one POST /import-file per book. Sequential keeps memory/socket pressure sane
// for 250MB PDFs, and the conversion queue serializes server-side anyway —
// the widget makes that serialization visible instead of broken.
//
// Failure of file k marks its item upload_failed (PATCH) and continues with
// k+1 — one corrupt file must not sink the other 30.

import { log, verbose } from '../../utilities/logger';
import { generateBookIdFromMetadata, findAvailableBookId } from '../newbookContainer/citeForm/bookId';
import { startImportQueuePolling } from './importQueuePoller';
import { drainResponse } from '../../utilities/drainResponse';
import { generateBibtexFromForm } from '../../utilities/bibtexProcessor';
import type { ImportBundle, ManifestEntry } from './folderIngest';

/**
 * Manifest fields forwarded to POST /import-file — an explicit whitelist
 * mirroring ManifestEntry (never iterate the object blindly). Each maps to a
 * request field ImportController writes to `library` authoritatively.
 */
const METADATA_KEYS: ReadonlyArray<keyof ManifestEntry> = [
  'title', 'author', 'year', 'url', 'publisher', 'journal', 'type', 'language',
  'note', 'bibtex', 'volume', 'issue', 'pages', 'booktitle', 'chapter', 'editor', 'school',
  'doi', 'license', 'license_url',
];

/** Above this many items, later book ids skip the per-id server availability
 * probe (a timestamp suffix guarantees uniqueness) so a 100-file vault doesn't
 * burn 100 validate-book-id calls against the shared throttle bucket. */
const VALIDATE_ID_CAP = 15;

export interface BatchUploadResult {
  batchId: string | null;
  uploaded: number;
  failed: number;
  /** Books already in Hyperlit that went straight onto the shelf. */
  existingAdded: number;
  /** Where the shelf lives, when the batch has one. */
  shelfUrl: string | null;
}

/**
 * A stored BibTeX entry for a note whose folder gave it citation details but
 * no .bib entry — library cards render `bibtex` in preference to the columns,
 * so without one the author/year the vault supplied would never show.
 */
function bibtexFor(meta: ManifestEntry, book: string, title: string): string | null {
  if (meta.bibtex) return meta.bibtex;
  if (!meta.author && meta.year == null) return null;
  return generateBibtexFromForm({ ...meta, year: meta.year != null ? String(meta.year) : '', book, title });
}

function csrfToken(): string {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta instanceof HTMLMetaElement ? meta.content : '';
}

function sanitizeBase(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, '');
  return clean || `import_${Date.now()}`;
}

async function bookIdFor(bundle: ImportBundle, index: number, taken: Set<string>): Promise<string> {
  const meta = bundle.metadata;
  const base = sanitizeBase(generateBookIdFromMetadata(
    meta?.bibtex ?? null,
    bundle.title,
    meta?.author ?? null,
    meta?.year != null ? String(meta.year) : null,
  ));
  let id: string;
  if (index < VALIDATE_ID_CAP) {
    id = await findAvailableBookId(base);
  } else {
    id = `${base}_${Date.now() + index}`;
  }
  // Guard against intra-batch collisions (two "notes.md" in different dirs).
  while (taken.has(id)) id = `${id}_${index}`;
  taken.add(id);
  return id;
}

/**
 * Register the batch, then upload each bundle in order. Returns a summary;
 * the widget (already polling) is the progress UI.
 */
export async function uploadBatch(
  bundles: ImportBundle[],
  opts: {
    label: string;
    source: 'files' | 'folder' | 'vault';
    autoShelf: boolean;
    /**
     * Append completed books to this EXISTING shelf instead of an auto-shelf
     * (the maintainer shelf-import drop target). Server-authorized: admin or
     * shelf owner only. Mutually exclusive with autoShelf.
     */
    shelfId?: string;
    /** Present when the drop carried a manifest.json (a scrape folder) — recorded in raw_json. */
    manifest?: { schemaVersion: number; site?: string } | null;
    /** Fires once the batch is registered (before uploads) — e.g. close the form. */
    onCreated?: (batchId: string) => void;
    /**
     * Books ALREADY in Hyperlit to put straight on the shelf, no upload
     * (vaultResolve.ts). The server re-checks that the caller can read each.
     * With no bundles at all the call registers no batch — it only shelves.
     */
    existingBooks?: string[];
    /**
     * File the batch on the caller's private "Imported works" shelf (a single
     * upload that is already a book in Hyperlit). Ignored when shelfId or
     * autoShelf is set.
     */
    importsShelf?: boolean;
  },
): Promise<BatchUploadResult> {
  const existingBooks = opts.existingBooks ?? [];
  if (!bundles.length && !existingBooks.length) {
    return { batchId: null, uploaded: 0, failed: 0, existingAdded: 0, shelfUrl: null };
  }

  const taken = new Set<string>();
  const withIds: Array<{ bundle: ImportBundle; book: string }> = [];
  for (let i = 0; i < bundles.length; i++) {
    const bundle = bundles[i];
    if (!bundle) continue;
    withIds.push({ bundle, book: await bookIdFor(bundle, i, taken) });
  }

  const createResp = await fetch('/api/import-batches', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-CSRF-TOKEN': csrfToken(),
    },
    credentials: 'include',
    body: JSON.stringify({
      label: opts.label,
      source: opts.source,
      auto_shelf: opts.autoShelf,
      ...(opts.shelfId ? { shelf_id: opts.shelfId } : {}),
      ...(opts.importsShelf && !opts.shelfId ? { imports_shelf: true } : {}),
      items: withIds.map(({ bundle, book }) => ({
        book,
        title: bundle.title,
        filename: bundle.filename,
      })),
      ...(existingBooks.length ? { existing_books: existingBooks } : {}),
    }),
  });
  const created = await createResp.json().catch(() => null) as
    | { id?: string | null; shelf_url?: string | null; existing_added?: number; message?: string }
    | null;
  if (!createResp.ok || !created) {
    throw new Error(created?.message || `Could not register the import batch (server returned ${createResp.status}).`);
  }
  const existingAdded = Number(created.existing_added ?? 0);
  const shelfUrl = typeof created.shelf_url === 'string' ? created.shelf_url : null;

  // Nothing to upload: the existing books are on the shelf and that is the
  // whole job — no batch was registered, so there is nothing for the widget.
  if (!withIds.length || !created.id) {
    return { batchId: null, uploaded: 0, failed: 0, existingAdded, shelfUrl };
  }
  const batchId = String(created.id);

  // The widget takes over as the progress UI from here.
  startImportQueuePolling();
  try {
    opts.onCreated?.(batchId);
  } catch { /* caller UI errors must not stop the uploads */ }

  let uploaded = 0;
  let failed = 0;

  for (const { bundle, book } of withIds) {
    const formData = new FormData();
    formData.append('book', book);
    formData.append('title', bundle.title);
    formData.append('import_batch_id', batchId);
    if (bundle.metadata) {
      const bibtex = bibtexFor(bundle.metadata, book, bundle.title);
      for (const key of METADATA_KEYS) {
        if (key === 'title') continue; // already sent via bundle.title
        const value = key === 'bibtex' ? bibtex : bundle.metadata[key];
        if (value != null && String(value).trim()) {
          formData.append(key, String(value).trim());
        }
      }
    }
    // The user's own version of a book already in Hyperlit (vaultResolve.ts):
    // the server copies its citation details and links the same canonical work.
    if (bundle.versionOf) formData.append('version_of', bundle.versionOf);
    if (opts.manifest) {
      // Provenance breadcrumbs — land in library.raw_json server-side.
      formData.append('imported_via', 'scrape-folder');
      formData.append('manifest_schema_version', String(opts.manifest.schemaVersion));
      if (opts.manifest.site) formData.append('scrape_site', opts.manifest.site);
    }
    formData.append('markdown_file[]', bundle.rewrittenMain || bundle.mainFile);
    for (const img of bundle.images) {
      formData.append('markdown_file[]', img);
    }

    try {
      const resp = await fetch('/import-file', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'X-CSRF-TOKEN': csrfToken() },
        credentials: 'include',
        body: formData,
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({} as Record<string, unknown>));
        throw new Error(String((data as { message?: string }).message || `Upload failed (${resp.status})`));
      }
      uploaded++;
      verbose.content(`batchUploader: uploaded "${bundle.filename}" as ${book}`, '/components/importQueue/batchUploader.ts');
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      log.error(`batchUploader: upload of "${bundle.filename}" failed — continuing with the rest`, '/components/importQueue/batchUploader.ts', message);
      try {
        await drainResponse(await fetch(`/api/import-batches/${batchId}/items/${book}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-CSRF-TOKEN': csrfToken(),
          },
          credentials: 'include',
          body: JSON.stringify({ status: 'upload_failed', error: message.slice(0, 2000) }),
        }));
      } catch { /* the widget will just keep showing pending_upload */ }
    }
  }

  return { batchId, uploaded, failed, existingAdded, shelfUrl };
}

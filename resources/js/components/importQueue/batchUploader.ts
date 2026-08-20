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
import type { ImportBundle } from './folderIngest';

/** Above this many items, later book ids skip the per-id server availability
 * probe (a timestamp suffix guarantees uniqueness) so a 100-file vault doesn't
 * burn 100 validate-book-id calls against the shared throttle bucket. */
const VALIDATE_ID_CAP = 15;

export interface BatchUploadResult {
  batchId: string | null;
  uploaded: number;
  failed: number;
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
  const base = sanitizeBase(generateBookIdFromMetadata(null, bundle.title, null, null));
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
    /** Fires once the batch is registered (before uploads) — e.g. close the form. */
    onCreated?: (batchId: string) => void;
  },
): Promise<BatchUploadResult> {
  if (!bundles.length) return { batchId: null, uploaded: 0, failed: 0 };

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
      items: withIds.map(({ bundle, book }) => ({
        book,
        title: bundle.title,
        filename: bundle.filename,
      })),
    }),
  });
  if (!createResp.ok) {
    throw new Error(`Could not register the import batch (server returned ${createResp.status}).`);
  }
  const created = await createResp.json();
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
        await fetch(`/api/import-batches/${batchId}/items/${book}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-CSRF-TOKEN': csrfToken(),
          },
          credentials: 'include',
          body: JSON.stringify({ status: 'upload_failed', error: message.slice(0, 2000) }),
        });
      } catch { /* the widget will just keep showing pending_upload */ }
    }
  }

  return { batchId, uploaded, failed };
}

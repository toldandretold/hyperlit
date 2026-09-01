/**
 * Drop target for the shelf-import DETAIL page: drag PDFs / a scrape folder
 * anywhere onto /maintainer/shelf-import/{uuid} and the drop imports as a
 * batch that appends to THIS shelf (explicit shelf_id — authorized server-side
 * in ImportBatchController, admin or shelf owner).
 *
 * Deliberately standalone: maintainer blades are non-SPA (no ButtonRegistry,
 * no import-queue widget, no #importBook form), so this module owns its own
 * drag affordance + a small status line, and reuses the SPA's pure pieces —
 * folderIngest for planning, batchUploader for the uploads, and the DOM-free
 * import-queue poller for progress. Even a SINGLE dropped file becomes a
 * one-bundle batch: on this page every drop targets the shelf.
 */

import { log, verbose } from '../utilities/logger';
import {
  captureDropEntries, collectEntries, buildIngestPlan, planAsBatch,
} from '../components/importQueue/folderIngest';
import type { CollectedFile } from '../components/importQueue/folderIngest';
import { uploadBatch } from '../components/importQueue/batchUploader';
import { subscribeImportQueue } from '../components/importQueue/importQueuePoller';
import type { ImportQueueBatch } from '../components/importQueue/importQueuePoller';

const TERMINAL = new Set(['complete', 'failed', 'upload_failed']);

let hintEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let dragDepth = 0;
let statusHideTimer: number | undefined;
const unsubscribers = new Set<() => void>();

function isFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true;
  }
  return false;
}

function ensureUi(): void {
  if (hintEl && statusEl) return;

  hintEl = document.createElement('div');
  hintEl.id = 'ji-drop-hint';
  hintEl.textContent = 'Drop PDFs or a scrape folder to import onto this shelf';
  hintEl.hidden = true;
  document.body.appendChild(hintEl);

  statusEl = document.createElement('div');
  statusEl.id = 'ji-drop-status';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.hidden = true;
  document.body.appendChild(statusEl);
}

function showStatus(text: string, autoHideMs?: number): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.hidden = false;
  window.clearTimeout(statusHideTimer);
  if (autoHideMs) {
    statusHideTimer = window.setTimeout(() => {
      if (statusEl) statusEl.hidden = true;
    }, autoHideMs);
  }
}

/** Progress via the shared aggregate poller: watch OUR batch until every item lands. */
function watchBatch(batchId: string, label: string, onSettled: () => void): void {
  let settled = false;
  const unsubscribe = subscribeImportQueue((state) => {
    if (settled) return;
    const batch: ImportQueueBatch | undefined = state?.batches.find((b) => b.id === batchId);
    if (!batch) return; // first poll may not have landed yet

    const total = batch.items.length;
    const done = batch.items.filter((i) => TERMINAL.has(i.status)).length;
    const failed = batch.items.filter((i) => i.status === 'failed' || i.status === 'upload_failed').length;

    if (done < total) {
      showStatus(`importing ${done}/${total} — ${label}`);
      return;
    }

    settled = true;
    unsubscribe();
    unsubscribers.delete(unsubscribe);
    showStatus(
      failed
        ? `imported ${total - failed}/${total} onto the shelf — ${failed} failed (see /my-imports)`
        : `imported ${total} onto the shelf`,
      8000,
    );
    onSettled();
  });
  unsubscribers.add(unsubscribe);
}

async function handleDrop(
  shelfId: string,
  entries: ReturnType<typeof captureDropEntries>,
  plainFiles: File[],
  onBatchSettled: () => void,
): Promise<void> {
  let collected: CollectedFile[];
  let rootDirName: string | null = null;

  if (entries) {
    const res = await collectEntries(entries);
    collected = res.files;
    rootDirName = res.rootDirName;
    if (!collected.length && plainFiles.length) {
      collected = plainFiles.map((f) => ({ file: f, relPath: f.name }));
    }
  } else {
    if (!plainFiles.length) {
      showStatus('Folder drop is not supported in this browser — drop individual files instead.', 8000);
      return;
    }
    collected = plainFiles.map((f) => ({ file: f, relPath: f.name }));
  }

  let plan = await buildIngestPlan(collected, rootDirName);
  // On this page every drop targets the shelf, so single-file shapes become a
  // one-bundle batch (there is no import form here to attach them to).
  if (plan.kind === 'single' || plan.kind === 'one-book-folder') {
    plan = planAsBatch(plan);
  }
  if (plan.kind !== 'batch' || !plan.bundles.length) {
    showStatus('Nothing importable in that drop — PDF, EPUB, DOCX, MD, HTML or image files.', 8000);
    return;
  }

  const first = plan.bundles[0];
  const label = plan.folderName
    || (plan.bundles.length === 1 && first ? first.title : `Shelf import ${new Date().toISOString().slice(0, 10)}`);

  showStatus(`registering ${plan.bundles.length} import${plan.bundles.length === 1 ? '' : 's'}…`);
  try {
    const result = await uploadBatch(plan.bundles, {
      label,
      source: plan.source,
      autoShelf: false,
      shelfId,
      manifest: plan.manifest,
    });
    if (!result.batchId) {
      showStatus('Nothing was uploaded.', 8000);
      return;
    }
    verbose.content(
      `shelfDrop: batch ${result.batchId} — ${result.uploaded} uploaded, ${result.failed} failed`,
      '/maintainerJournalImport/shelfDrop.ts',
    );
    watchBatch(result.batchId, label, onBatchSettled);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('shelfDrop: batch registration failed', '/maintainerJournalImport/shelfDrop.ts', message);
    showStatus(`Import failed: ${message}`, 12000);
  }
}

/**
 * Wire the whole document as a drop target for this shelf. `onBatchSettled`
 * fires when every item of a dropped batch reaches a terminal state — the
 * caller reloads the articles pane so the new books appear.
 */
export function initShelfDrop(shelfId: string, onBatchSettled: () => void): void {
  ensureUi();

  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    if (dragDepth === 1 && hintEl) hintEl.hidden = false;
  });

  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    // MUST preventDefault on every dragover or the browser navigates to the
    // dropped file when it lands outside a drop handler.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && hintEl) hintEl.hidden = true;
  });

  window.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    if (hintEl) hintEl.hidden = true;

    // Capture directory entries SYNCHRONOUSLY — webkitGetAsEntry() results
    // are invalidated the moment this handler yields.
    const entries = e.dataTransfer ? captureDropEntries(e.dataTransfer) : null;
    const plainFiles: File[] = Array.from(e.dataTransfer?.files ?? []);
    if (!entries && !plainFiles.length) return;

    void handleDrop(shelfId, entries, plainFiles, onBatchSettled);
  });

  // A leaked subscription would keep the poller's callbacks alive across the
  // page teardown; drop them (the poller singleton manages its own loop).
  window.addEventListener('pagehide', () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers.clear();
  });

  verbose.init(`shelfDrop: drop target armed for shelf ${shelfId}`, '/maintainerJournalImport/shelfDrop.ts');
}

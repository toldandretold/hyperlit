// Which cite-form fields the UPLOADED DOCUMENT filled in, and whether the user has
// since taken them over.
//
// The draft (citeForm/persistence.ts) deliberately survives a close/reopen, so the
// metadata of a previous attempt comes back with it. But the file-metadata autofill
// writes with `setIfEmpty`, so a restored title/author/citation-id silently BLOCKED
// the new document's own metadata — the next PDF shipped under the last PDF's title
// and slug, with nothing on screen to say so.
//
// So autofill marks what it wrote (`data-autofilled`), a real keystroke in the field
// drops the mark, and swapping in a different document clears exactly the fields the
// previous document wrote — anything the user typed themselves is left alone.
import { $ } from './dom';

/** The fields handleFileMetadataExtraction / showPdfCostEstimate derive from a file. */
export const FILE_AUTOFILLED_FIELD_IDS = ['title', 'author', 'year', 'book'] as const;

const isTrackedField = (id: string): boolean =>
  (FILE_AUTOFILLED_FIELD_IDS as readonly string[]).includes(id);

export function markFieldAutofilled(el: any): void {
  if (el?.dataset) el.dataset.autofilled = '1';
}

// Every write below fires the `input` the rest of the form listens on (validation,
// draft save). The watcher has to tell those apart from a keystroke — and it cannot
// do that from `event.isTrusted`, which is also false for every synthetic event a
// test or a future caller dispatches. So the DOCUMENT's writes announce themselves
// instead: anything arriving outside this window is the user's.
let documentWriteDepth = 0;

export function withDocumentWrite<T>(fn: () => T): T {
  documentWriteDepth++;
  try {
    return fn();
  } finally {
    documentWriteDepth--;
  }
}

/** Write a value the uploaded document supplied, mark it as the document's, and
 *  notify the form — the one way autofill should touch a tracked field. */
export function setFieldFromDocument(el: any, value: string): void {
  if (!el) return;
  el.value = value;
  markFieldAutofilled(el);
  withDocumentWrite(() => el.dispatchEvent(new Event('input', { bubbles: true })));
}

/** Ids still carrying the mark — persisted with the draft so a restored attempt
 *  remembers which of its values came from the document rather than the user. */
export function getAutofilledFieldIds(): string[] {
  return FILE_AUTOFILLED_FIELD_IDS.filter((id) => $(id)?.dataset?.autofilled === '1');
}

export function restoreAutofilledMarks(ids: unknown): void {
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    if (typeof id === 'string' && isTrackedField(id)) markFieldAutofilled($(id));
  }
}

export function clearAllAutofilledMarks(): void {
  for (const id of FILE_AUTOFILLED_FIELD_IDS) {
    const el = $(id);
    if (el?.dataset) delete el.dataset.autofilled;
  }
}

/** Blank every field still marked as the previous document's, and report which
 *  ids were cleared (the caller re-syncs anything derived from them — the /url
 *  preview, validation messages). Fields the user typed keep their value. */
export function clearAutofilledFields(): string[] {
  const cleared: string[] = [];
  for (const id of FILE_AUTOFILLED_FIELD_IDS) {
    const el = $(id);
    if (!el || el.dataset?.autofilled !== '1') continue;
    el.value = '';
    delete el.dataset.autofilled;
    cleared.push(id);
    withDocumentWrite(() => el.dispatchEvent(new Event('input', { bubbles: true })));
  }
  return cleared;
}

/** One delegated listener: an `input` on a tracked field hands the field to the
 *  user, UNLESS it came from a document write (above). Without that exclusion the
 *  mark would be dropped by the very event that announces it was set. */
export function watchForManualFieldEdits(): void {
  const form = $('cite-form');
  if (!form || form._autofillWatcherAttached) return;
  form._autofillWatcherAttached = true;
  form.addEventListener('input', (e: any) => {
    if (documentWriteDepth > 0) return;
    const target = e.target;
    if (target?.id && isTrackedField(target.id) && target.dataset) {
      delete target.dataset.autofilled;
    }
  });
}

// ─── Which document is currently attached ────────────────────────────────────
// Module state, not DOM state: the form is re-injected on every open, so the
// "is this the same file as last time?" question has to outlive the markup.

let lastFileSignature: string | null = null;

function signatureOf(fileInput: any): string {
  const files = fileInput?.files;
  if (!files || files.length === 0) return '';
  return Array.from(files)
    .map((f: any) => `${f.name}|${f.size}|${f.lastModified}`)
    .join('::');
}

/** True when this selection is a DIFFERENT document from the one last seen —
 *  re-picking the same file (the dropzone's "drop another to swap" invites a
 *  re-drop) is not a swap and must not discard its own autofill. */
export function isNewFileSelection(fileInput: any): boolean {
  const signature = signatureOf(fileInput);
  const changed = signature !== lastFileSignature;
  lastFileSignature = signature;
  return changed && signature !== '';
}

export function resetFileSelectionTracking(): void {
  lastFileSignature = null;
}

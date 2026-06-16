// Reconvert section (#reconvert-section / #reconvert-btn) inside Creator Tools:
// re-process the book from its source/OCR cache. handleReconvert triggers the
// background job; _awaitReconvert polls progress, shows the footnote-audit
// modal if needed, clears stale IDB content, and reloads. Shared by the
// re-upload path (which also calls self._awaitReconvert). Takes `self`.
import { book } from '../../../app.js';
import { pollImportProgress, showFootnoteAuditModal } from '../../../SPA/navigation/navigationRegistry';

export async function loadReconvertInfo(self: any) {
  try {
    const resp = await fetch(`/api/books/${encodeURIComponent(book)}/reconvert-info`, { credentials: 'include' });
    if (!resp.ok) return;
    const info = await resp.json();
    if (!info.canReconvert) return;

    const label = info.hasOcrCache ? 'Reconvert from OCR cache' : 'Reconvert from source';
    const section = self.container.querySelector("#reconvert-section");
    if (!section) return;

    section.style.display = '';
    section.innerHTML = `
        <button type="button" id="reconvert-btn" style="width: 100%; padding: 8px 12px; font-size: 13px; color: var(--hyperlit-orange); border: 1px solid rgba(239,141,52,0.4); background: transparent; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="1 4 1 10 7 10"></polyline>
            <polyline points="23 20 23 14 17 14"></polyline>
            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path>
          </svg>
          ${label}
        </button>
        <p style="font-size: 11px; color: var(--color-text-faint); margin-top: 6px;">Re-process from source files. Existing content will be replaced.</p>`;

    // Attach listener to the newly created button
    const btn = section.querySelector("#reconvert-btn");
    if (btn) btn.addEventListener("click", (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      self.handleReconvert();
    });
  } catch (e) {
    console.warn('Could not check reconvert availability:', e);
  }
}

export async function handleReconvert(self: any) {
  if (!confirm(
    'This will re-process the book from its source files.\n\n' +
    'All existing content (nodes, footnotes, references) will be replaced.\n' +
    'You can use Version History to go back if needed.\n\nContinue?'
  )) return;

  const btn = self.container.querySelector("#reconvert-btn");
  if (btn) { btn.disabled = true; btn.textContent = 'Reconverting...'; }

  try {
    const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
    const resp = await fetch(`/api/books/${encodeURIComponent(book)}/reconvert`, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrfToken },
      credentials: 'include',
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || `Failed: ${resp.status}`);
    }

    const result = await resp.json();

    // Reconvert now runs as a background job; poll progress (showing live
    // percent on the button), then handle the audit + reload on completion.
    await self._awaitReconvert(result, book, {
      update(pct: any, msg: any) {
        if (btn) btn.textContent = pct != null ? `${msg || 'Reconverting'}… ${Math.round(pct)}%` : (msg || 'Reconverting…');
      },
      showError() {},
      restoreForm() {},
    });
  } catch (error: any) {
    console.error('Reconvert failed:', error);
    alert('Reconversion failed: ' + error.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Reconvert from source'; }
  }
}

/**
 * Wait for a reconvert/reupload to finish, then refresh the reader.
 *
 * The backend dispatches ProcessDocumentImportJob and returns
 * { status: 'processing' } immediately (see ImportController::reconvert) to
 * avoid the Cloudflare 524 / OOM that the old inline pipeline caused. We reuse
 * the import progress-polling helper, then show the footnote audit modal if
 * needed, clear the stale IndexedDB content, and reload.
 *
 * Backward-compatible: if the response already carries footnoteAudit (legacy
 * synchronous shape), we skip polling and use it directly.
 */
export async function _awaitReconvert(self: any, result: any, bookId: any, progressUI: any) {
  let completedResult = result;
  if (result?.status === 'processing') {
    const ui = progressUI || { update() {}, showError() {}, restoreForm() {} };
    const completeData = await pollImportProgress(bookId, ui);
    completedResult = completeData?.result || completeData;
  }

  // Show the footnote audit modal if the conversion flagged issues
  const audit = completedResult?.footnoteAudit;
  if (audit) {
    const hasIssues = (audit.gaps?.length || 0) +
      (audit.unmatched_refs?.length || 0) +
      (audit.unmatched_defs?.length || 0) +
      (audit.duplicates?.length || 0) > 0;
    if (hasIssues) {
      await showFootnoteAuditModal(audit, bookId, { mode: 'reconvert' });
    }
  }

  // Clear the now-stale IndexedDB content (keeps library record), then reload
  const { clearBookContentFromIndexedDB } = await import('../../../indexedDB/index');
  await clearBookContentFromIndexedDB(bookId);
  window.location.reload();
}

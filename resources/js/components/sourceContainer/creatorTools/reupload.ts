// Re-upload section (#reupload-dropzone / #reupload-file-input) inside Creator
// Tools: validate a dropped/selected file, POST it to the reconvert endpoint,
// and hand off to self._awaitReconvert for progress + reload. Takes `self`.
import { book } from '../../../app.js';

export async function handleReupload(self: any, file: any) {
  const statusEl = self.container.querySelector("#reupload-status");
  const dropzone = self.container.querySelector("#reupload-dropzone");

  const showError = (msg: string) => {
    if (statusEl) { statusEl.textContent = msg; statusEl.style.display = 'block'; }
  };
  const hideError = () => {
    if (statusEl) { statusEl.style.display = 'none'; }
  };

  hideError();

  // Validate extension
  const ext = file.name.split('.').pop().toLowerCase();
  const allowed = ['md', 'doc', 'docx', 'epub', 'html', 'pdf'];
  if (!allowed.includes(ext)) {
    showError(`Unsupported file type ".${ext}". Allowed: ${allowed.join(', ')}`);
    return;
  }

  // Validate size (50MB)
  if (file.size > 50 * 1024 * 1024) {
    showError('File must be less than 50MB.');
    return;
  }

  // Confirm
  if (!confirm(
    'This will replace all book content with the uploaded file. ' +
    'Existing content will be overwritten.\n\n' +
    'You can use Version History to go back if needed.\n\nContinue?'
  )) return;

  // Set uploading state
  if (dropzone) {
    dropzone.style.pointerEvents = 'none';
    dropzone.style.opacity = '0.5';
    dropzone.innerHTML = '<p style="font-size: 13px; color: var(--hyperlit-orange); margin: 0;">Uploading &amp; converting...</p>';
  }

  try {
    const csrfToken = (document.querySelector('meta[name="csrf-token"]') as any)?.content;
    const formData = new FormData();
    formData.append('file', file);

    const resp = await fetch(`/api/books/${encodeURIComponent(book)}/reconvert`, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'X-CSRF-TOKEN': csrfToken },
      credentials: 'include',
      body: formData,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || `Failed: ${resp.status}`);
    }

    const result = await resp.json();

    // Reconvert-with-upload runs as a background job; poll progress on the
    // dropzone, then handle the audit + reload on completion.
    await self._awaitReconvert(result, book, {
      update(pct: any, msg: any) {
        if (dropzone) {
          const label = pct != null ? `${msg || 'Converting'}… ${Math.round(pct)}%` : (msg || 'Converting…');
          dropzone.innerHTML = `<p style="font-size: 13px; color: var(--hyperlit-orange); margin: 0;">${label}</p>`;
        }
      },
      showError() {},
      restoreForm() {},
    });
  } catch (error: any) {
    console.error('Re-upload failed:', error);
    showError('Re-upload failed: ' + error.message);

    // Reset dropzone
    if (dropzone) {
      dropzone.style.pointerEvents = '';
      dropzone.style.opacity = '';
      dropzone.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-label)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 8px;">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <p style="font-size: 12px; color: var(--color-text-secondary); margin: 0 0 4px 0;">Drag & drop a file or click to select</p>
          <p style="font-size: 11px; color: var(--color-text-faint); margin: 0;">md, doc, docx, epub, html, pdf</p>`;
    }
  }
}

// Creator Tools panel (#creator-tools-content) — lazy-built on first expand.
// Renders the version-history / reconvert / re-upload / delete sections and
// wires their buttons to the SourceContainerManager (`self`), then kicks off
// the lazy API calls (version history + reconvert availability).
export async function loadCreatorTools(self: any) {
  if (self._creatorToolsLoaded) return;
  self._creatorToolsLoaded = true;

  const content = self.container.querySelector("#creator-tools-content");
  if (!content) return;

  // Build the HTML for version history, reconvert placeholder, reupload, and delete
  const html = `
      <div id="version-history-section" style="margin-top: 10px;">
        <h3>Version History</h3>
        <div id="version-history-list" style="font-size: var(--sc-13); color: var(--color-text-secondary);">Loading...</div>
      </div>

      <div id="reconvert-section" style="margin-top: 15px; padding-top: 15px; display: none;"></div>

      <div id="reupload-section" style="margin-top: 15px; padding-top: 15px;">
        <h3>Re-upload Source</h3>
        <div id="reupload-dropzone" style="border: 2px dashed rgba(136,136,136,0.4); border-radius: 6px; padding: 20px 12px; text-align: center; cursor: pointer; transition: border-color 0.2s;">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-label)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 8px;">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <p style="font-size: var(--sc-12); color: var(--color-text-secondary); margin: 0 0 4px 0;">Drag & drop a file or click to select</p>
          <p style="font-size: var(--sc-11); color: var(--color-text-faint); margin: 0;">md, doc, docx, epub, html, pdf</p>
        </div>
        <input type="file" id="reupload-file-input" accept=".md,.doc,.docx,.epub,.html,.pdf" style="display: none;">
        <p id="reupload-status" style="font-size: var(--sc-12); color: var(--color-danger); margin-top: 6px; display: none;"></p>
      </div>

      <div id="delete-book-section" style="margin-top: 20px; padding-top: 15px;">
        <button type="button" id="delete-book-btn" style="width: 100%; padding: 8px 12px; font-size: var(--sc-13); color: var(--color-danger); border: 1px solid rgba(215,58,73,0.4); background: transparent; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
          Delete Book
        </button>
        <p style="font-size: var(--sc-11); color: var(--color-text-faint); margin-top: 6px;">Permanently delete this book and all associated data.</p>
      </div>`;

  content.innerHTML = html;

  // Attach event listeners for reconvert, delete, reupload
  const reconvertBtn = content.querySelector("#reconvert-btn");
  if (reconvertBtn) reconvertBtn.addEventListener("click", (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    self.handleReconvert();
  });

  const deleteBtn = content.querySelector("#delete-book-btn");
  if (deleteBtn) deleteBtn.addEventListener("click", (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    self.handleDeleteBook();
  });

  const dropzone = content.querySelector("#reupload-dropzone");
  const fileInput = content.querySelector("#reupload-file-input");
  if (dropzone && fileInput) {
    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("dragover", (e: any) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--hyperlit-orange)';
    });
    dropzone.addEventListener("dragleave", () => {
      dropzone.style.borderColor = 'rgba(136,136,136,0.4)';
    });
    dropzone.addEventListener("drop", (e: any) => {
      e.preventDefault();
      dropzone.style.borderColor = 'rgba(136,136,136,0.4)';
      const file = e.dataTransfer.files[0];
      if (file) self.handleReupload(file);
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if (file) self.handleReupload(file);
      fileInput.value = '';
    });
  }

  // Fire off lazy API calls (harvest lives in Research Workflows now).
  self.loadVersionHistory();
  self.loadReconvertInfo();
}

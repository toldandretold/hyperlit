// The #cite-form HTML, injected into #newbook-container by the
// NewBookContainerManager. Moved verbatim out of newBookButton.showImportForm();
// behavior is wired by citeForm/index.ts (initializeCitationFormListeners).
export function getCiteFormHTML(): string {
  // Get the CSRF token from the meta tag.
  const csrfToken = document
    .querySelector('meta[name="csrf-token"]')!
    .getAttribute("content");

  // Detect mobile to conditionally enable folder upload (not supported on mobile)
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  const pdfAccept = ',.pdf,application/pdf';

  return `
      <div class="scroller">
      <form id="cite-form" action="/import-file" method="POST" enctype="multipart/form-data">
        <div class="form-header">
          <h2 style="color: #EF8D34;">Import</h2>
        </div>

        <input type="hidden" name="_token" value="${csrfToken}" id="submitFile">

        <!-- Source Toggle: URL import vs File upload -->
        <div class="import-source-toggle" role="tablist" aria-label="Import source">
          <button type="button" id="source-toggle-url" class="import-source-toggle-btn" role="tab" aria-selected="false">
            Import from URL
          </button>
          <button type="button" id="source-toggle-file" class="import-source-toggle-btn active" role="tab" aria-selected="true">
            Import a file
          </button>
        </div>

        <!-- URL Import Panel (hidden by default; shown when source-toggle-url active) -->
        <div id="import-source-url" class="import-source-panel" style="display:none;">
          <div class="form-section">
            <label for="import-url-input">arXiv URL or DOI</label>
            <div class="import-url-input-row">
              <input type="text" id="import-url-input" placeholder="https://arxiv.org/abs/… or 10.xxxx/…" autocomplete="off">
              <button type="button" id="import-url-fetch" class="formButton import-url-fetch-btn">Fetch</button>
            </div>
            <div class="field-hint">Paste an arXiv link, a DOI, or a doi.org URL.</div>
            <div id="import-url-status" class="validation-message"></div>
          </div>
          <div id="import-url-preview" class="import-url-preview" style="display:none;">
            <div id="import-url-preview-body"></div>
            <div class="form-section">
              <label for="import-url-book">/url</label>
              <input type="text" id="import-url-book" placeholder="e.g., nair2023-vr-ident" title="Only letters, numbers, underscores, and hyphens allowed">
              <div class="field-hint">hyperlit.io/<strong id="import-url-book-preview">your-id</strong></div>
            </div>
            <div class="form-actions">
              <button type="button" id="import-url-commit" class="formButton">Create Book</button>
            </div>
          </div>
        </div>

        <!-- File-import body (everything below is the existing flow) -->
        <div id="import-source-file">

        <!-- Mode Selector Tabs -->
        <div class="import-mode-selector">
          <div class="import-mode-group">
            <label class="import-mode-label">
              <input type="radio" name="import_mode" value="search" checked>
              <span>Search</span>
            </label>
            <label class="import-mode-label">
              <input type="radio" name="import_mode" value="bibtex">
              <span>BibTeX</span>
            </label>
            <label class="import-mode-label">
              <input type="radio" name="import_mode" value="manual">
              <span>Manual</span>
            </label>
          </div>
        </div>

        <!-- Search Mode Panel -->
        <div id="import-mode-search" class="import-mode-panel">
          <input type="text" id="import-search-input" placeholder="Search by title, author, or keyword..." autocomplete="off">
          <div class="import-search-results" id="import-search-results"></div>
        </div>

        <!-- BibTeX Mode Panel -->
        <div id="import-mode-bibtex" class="import-mode-panel" style="display:none;">
          <label for="bibtex">Paste BibTeX entry</label>
          <textarea id="bibtex" name="bibtex" placeholder="@article{key,&#10;  author = {Author Name},&#10;  title = {Title},&#10;  year = {2024},&#10;  ...&#10;}"></textarea>
          <div class="field-hint">Fields will auto-fill when a valid entry is detected</div>
        </div>

        <!-- Library Match Notice -->
        <div id="library-match-notice" class="import-library-notice" style="display:none;">
          <p>This source already exists in the library.</p>
          <div class="import-library-notice-actions">
            <a id="library-match-view" href="#" class="formButton">View existing source</a>
            <button type="button" id="library-match-own" class="formButton">Create your own version</button>
          </div>
        </div>

        <!-- File Upload Section - always visible -->
        <div class="form-section">
          <label for="markdown_file" class="required">File <span class="required-indicator">*</span></label>
          <input type="file" id="markdown_file" name="markdown_file[]" accept=".md,.epub,.doc,.docx,.html,.jpg,.jpeg,.png,.gif,.webp,.svg,text/markdown,application/epub+zip,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/html,image/*${pdfAccept}" ${isMobile || /firefox/i.test(navigator.userAgent) || /chrome/i.test(navigator.userAgent) ? '' : 'webkitdirectory'} multiple>
          <div id="markdown-file-dropzone" tabindex="0" role="button" aria-label="Drop a file here or click to choose"
               style="margin-top:10px; padding:18px 12px; border:2px dashed rgba(136,136,136,0.4); border-radius:8px; text-align:center; cursor:pointer; transition:border-color 0.15s ease, background-color 0.15s ease;">
            <div class="markdown-file-dropzone-icon" style="font-size:24px; line-height:1; color:#888; margin-bottom:6px;">⤓</div>
            <div class="markdown-file-dropzone-text" style="font-size:13px; color:#888;"><strong>Drop a file here</strong> or use the button above</div>
          </div>
          <div class="field-hint">Upload a document file</div>
          <div id="file-validation" class="validation-message"></div>
          <div id="pdf-cost-estimate" style="display:none;"></div>
        </div>

        <!-- /url field with preview - always visible -->
        <div class="form-section">
          <label for="book">/url</label>
          <input type="text" id="book" name="book"
                 placeholder="e.g., smith2023, doe_2024_book"
                 title="Only letters, numbers, underscores, and hyphens allowed">
          <div class="field-hint">hyperlit.io/<strong id="book-url-preview">your-id</strong></div>
          <div id="book-validation" class="validation-message"></div>
        </div>

        <!-- Title field - always visible -->
        <div class="form-section">
          <label for="title">Title</label>
          <input type="text" id="title" name="title" placeholder="Enter document title">
        </div>

        <!-- Detail fields (hidden in search/bibtex modes, shown in manual mode) -->
        <div id="import-form-fields" style="display:none;">

          <!-- Type Selection -->
          <div class="form-section">
            <label>Document Type:</label>
            <div class="radio-group">
              <label><input type="radio" name="type" value="article"> Article</label>
              <label><input type="radio" name="type" value="book" checked> Book</label>
              <label><input type="radio" name="type" value="phdthesis"> PhD Thesis</label>
              <label><input type="radio" name="type" value="misc"> Miscellaneous</label>
              <label><input type="radio" name="type" value="incollection"> Chapter</label>
            </div>
          </div>

          <div class="form-section">
            <label for="author">Author</label>
            <input type="text" id="author" name="author" placeholder="Author name">

            <label for="year">Year</label>
            <input type="number" id="year" name="year" min="1000" max="${new Date().getFullYear() + 10}" placeholder="Publication year">

            <label for="url">URL</label>
            <input type="url" id="url" name="url" placeholder="https://...">

            <!-- Type-specific fields -->
            <label for="pages" class="optional-field" style="display:none;">Pages</label>
            <input type="text" id="pages" name="pages" class="optional-field" style="display:none;" placeholder="e.g., 1-20, 45-67">

            <label for="journal" class="optional-field" style="display:none;">Journal</label>
            <input type="text" id="journal" name="journal" class="optional-field" style="display:none;" placeholder="Journal name">

            <label for="publisher" class="optional-field" style="display:none;">Publisher</label>
            <input type="text" id="publisher" name="publisher" class="optional-field" style="display:none;" placeholder="Publisher name">

            <label for="school" class="optional-field" style="display:none;">School</label>
            <input type="text" id="school" name="school" class="optional-field" style="display:none;" placeholder="University/School name">

            <label for="note" class="optional-field" style="display:none;">Note</label>
            <input type="text" id="note" name="note" class="optional-field" style="display:none;" placeholder="Additional notes">

            <label for="volume" class="optional-field" style="display:none;">Volume</label>
            <input type="text" id="volume" name="volume" class="optional-field" style="display:none;" placeholder="e.g., 12">

            <label for="issue" class="optional-field" style="display:none;">Issue</label>
            <input type="text" id="issue" name="issue" class="optional-field" style="display:none;" placeholder="e.g., 3">

            <label for="booktitle" class="optional-field" style="display:none;">Book Title</label>
            <input type="text" id="booktitle" name="booktitle" class="optional-field" style="display:none;" placeholder="Title of the book this chapter appears in">

            <label for="chapter" class="optional-field" style="display:none;">Chapter</label>
            <input type="text" id="chapter" name="chapter" class="optional-field" style="display:none;" placeholder="Chapter number or title">

            <label for="editor" class="optional-field" style="display:none;">Editor</label>
            <input type="text" id="editor" name="editor" class="optional-field" style="display:none;" placeholder="Editor name(s)">
          </div>
        </div>

        <div id="form-validation-summary" class="validation-summary" style="display:none;">
          <h4>Please fix the following issues:</h4>
          <ul id="validation-list"></ul>
        </div>

        <div class="form-actions">
          <button type="submit" id="createButton" class="formButton">Create Book</button>
          <button type="button" id="clearButton" class="formButton">Clear</button>
        </div>

        </div> <!-- /#import-source-file -->
      </form>
      </div>
     <div class="mask-top"></div>
    <div class="mask-bottom"></div>
  `;
}

import { ContainerManager } from "../containerManager.js";
import { log, verbose } from "../utilities/logger.js";
import { openDatabase, getNodeChunksFromIndexedDB, prepareLibraryForIndexedDB, cleanLibraryItemForStorage } from "../indexedDB/index.js";
import { formatBibtexToCitation, generateBibtexFromForm } from "../utilities/bibtexProcessor.js";
import { book } from "../app.js";
import { canUserEditBook } from "../utilities/auth.js";

// SVG icons for privacy toggle
const PUBLIC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2ea44f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="10"/>
  <line x1="2" y1="12" x2="22" y2="12"/>
  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
</svg>`;

const PRIVATE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d73a49" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
</svg>`;

function getRecord(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
/**
 * Build the inner-HTML for the source container:
 *  - fetch bibtex from IndexedDB
 *  - format it to a citation
 *  - append a Download section with two buttons
 */
async function buildSourceHtml(currentBookId) {
  const db = await openDatabase();
  let record = await getRecord(db, "library", book);

  // If not in IndexedDB, try fetching from server
  let accessDenied = false;
  if (!record) {
    try {
      const response = await fetch(`/api/database-to-indexeddb/books/${encodeURIComponent(book)}/library`, {
        credentials: 'include'
      });
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.library) {
          record = data.library;
          // Cache it in IndexedDB for next time
          const tx = db.transaction("library", "readwrite");
          tx.objectStore("library").put(record);
        }
      } else if (response.status === 404 || response.status === 403) {
        // Book not accessible - might be private and user logged out
        accessDenied = true;
        console.warn("Library record not accessible - book may be private");
      }
    } catch (error) {
      console.warn("Failed to fetch library record from server:", error);
    }
  }

  console.log("buildSourceHtml got:", { book, record, accessDenied });

  let bibtex = record?.bibtex || "";
  
  // If no bibtex exists, generate one from available record data
  if (!bibtex && record) {
    const year = new Date(record.timestamp).getFullYear();
    const urlField = record.url ? `  url = {${record.url}},\n` : '';
    const publisherField = record.publisher ? `  publisher = {${record.publisher}},\n` : '';
    const journalField = record.journal ? `  journal = {${record.journal}},\n` : '';
    const pagesField = record.pages ? `  pages = {${record.pages}},\n` : '';
    const schoolField = record.school ? `  school = {${record.school}},\n` : '';
    const noteField = record.note ? `  note = {${record.note}},\n` : '';
    const volumeField = record.volume ? `  volume = {${record.volume}},\n` : '';
    const issueField = record.issue ? `  number = {${record.issue}},\n` : '';
    const booktitleField = record.booktitle ? `  booktitle = {${record.booktitle}},\n` : '';
    const chapterField = record.chapter ? `  chapter = {${record.chapter}},\n` : '';
    const editorField = record.editor ? `  editor = {${record.editor}},\n` : '';

    bibtex = `@${record.type || 'book'}{${record.book},
  author = {${record.author || record.creator || 'Unknown Author'}},
  title = {${record.title || 'Untitled'}},
  year = {${year}},
${urlField}${publisherField}${journalField}${pagesField}${schoolField}${noteField}${volumeField}${issueField}${booktitleField}${chapterField}${editorField}}`;

  }
  
  const citation = (await formatBibtexToCitation(bibtex)).trim();

  // Check if user can edit this book
  let canEdit;
  try {
    canEdit = await canUserEditBook(book);
  } catch (error) {
    console.error("Error checking edit permissions:", error);
    canEdit = false;
  }

  // Only show edit button if user can edit AND we have access to the record
  const editButtonHtml = (canEdit && !accessDenied && record) ? `
    <!-- Edit Button in bottom right corner -->
    <button id="edit-source" style="position: absolute; bottom: 10px; right: 10px; z-index: 1002;">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        style="pointer-events: none;"
      >
        <path d="M12 20h9" stroke="#CBCCCC" />
        <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" stroke="#CBCCCC" />
      </svg>
    </button>` : '';

  // Only show privacy toggle if user can edit AND we have access to the record
  // Don't show toggle if access was denied (e.g., private book after logout)
  const isPrivate = record?.visibility === 'private';
  const privacyToggleHtml = (canEdit && !accessDenied && record) ? `
    <!-- Privacy Toggle in top right corner -->
    <button id="privacy-toggle"
            data-is-private="${isPrivate}"
            style="position: absolute; top: 10px; right: 10px; z-index: 1002;"
            title="${isPrivate ? 'Book is Private - Click to make public' : 'Book is Public - Click to make private'}">
      ${isPrivate ? PRIVATE_SVG : PUBLIC_SVG}
    </button>` : '';

  // Get license info
  const license = record?.license || 'CC-BY-SA-4.0-NO-AI';
  const LICENSE_INFO = {
    'CC-BY-SA-4.0-NO-AI': { short: 'CC BY-SA 4.0 (No AI)', url: '/license2025content' },
    'CC-BY-4.0': { short: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
    'CC-BY-NC-SA-4.0': { short: 'CC BY-NC-SA 4.0', url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' },
    'CC0': { short: 'CC0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
    'All-Rights-Reserved': { short: 'All Rights Reserved', url: null },
    'custom': { short: 'Custom License', url: null }
  };

  const licenseInfo = LICENSE_INFO[license] || LICENSE_INFO['CC-BY-SA-4.0-NO-AI'];
  let licenseHtml = '';

  if (licenseInfo.url) {
    licenseHtml = `<p style="font-size: 12px; color: #888; margin-top: 10px;">📄 <a href="${licenseInfo.url}" target="_blank" style="color: #888; text-decoration: underline;">${licenseInfo.short}</a></p>`;
  } else if (license === 'custom' && record?.custom_license_text) {
    const escapedText = record.custom_license_text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    licenseHtml = `<p style="font-size: 12px; color: #888; margin-top: 10px; cursor: help;" title="${escapedText}">📄 ${licenseInfo.short}</p>`;
  } else {
    licenseHtml = `<p style="font-size: 12px; color: #888; margin-top: 10px;">📄 ${licenseInfo.short}</p>`;
  }

  return `
    <div class="scroller" id="source-content">
    <p class="citation">${citation}</p>
    ${licenseHtml}

    <br/>
    
    <button type="button" id="download-md" class="download-btn">
  <div class="icon-wrapper">
    <svg
      class="download-icon"
      viewBox="0 0 24 24"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
        <!-- no <rect> or white box here; just the two paths -->
        <path
          fill="currentColor"
          d="M14.481 14.015c-.238 0-.393.021-.483.042v3.089c.091.021.237.021.371.021.966.007 1.597-.525 1.597-1.653.007-.981-.568-1.499-1.485-1.499z"
        />
        <path
          fill="currentColor"
          d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-2.934 15.951-.07-1.807a53.142 53.142 0 0 1-.042-1.94h-.021a26.098 26.098 0 0 1-.525 1.828l-.574 1.842H9l-.504-1.828a21.996 21.996 0 0 1-.428-1.842h-.013c-.028.638-.049 1.366-.084 1.954l-.084 1.793h-.988L7.2 13.23h1.422l.462 1.576c.147.546.295 1.135.399 1.688h.021a39.87 39.87 0 0 1 .448-1.694l.504-1.569h1.394l.26 4.721h-1.044zm5.25-.56c-.498.413-1.253.609-2.178.609a9.27 9.27 0 0 1-1.212-.07v-4.636a9.535 9.535 0 0 1 1.443-.099c.896 0 1.478.161 1.933.505.49.364.799.945.799 1.778 0 .904-.33 1.528-.785 1.913zM14 9h-1V4l5 5h-4z"
        />
      </svg>
      </div>
    </button>


    <button type="button" id="download-docx" class="download-btn">
  <div class="icon-wrapper">
    <svg
      class="download-icon"
      viewBox="0 0 31.004 31.004"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g fill="currentColor">
        <!-- Remove inline style="fill:#030104;" -->
        <path d="M22.399,31.004V26.49c0-0.938,0.758-1.699,1.697-1.699l3.498-0.1L22.399,31.004z"/>
        <path d="M25.898,0H5.109C4.168,0,3.41,0.76,3.41,1.695v27.611c0,0.938,0.759,1.697,1.699,1.697h15.602v-6.02
          c0-0.936,0.762-1.697,1.699-1.697h5.185V1.695C27.594,0.76,26.837,0,25.898,0z
          M24.757,14.51c0,0.266-0.293,0.484-0.656,0.484H6.566c-0.363,0-0.658-0.219-0.658-0.484v-0.807
          c0-0.268,0.295-0.484,0.658-0.484h17.535c0.363,0,0.656,0.217,0.656,0.484L24.757,14.51z
          M24.757,17.988c0,0.27-0.293,0.484-0.656,0.484H6.566c-0.363,0-0.658-0.215-0.658-0.484v-0.805
          c0-0.268,0.295-0.486,0.658-0.486h17.535c0.363,0,0.656,0.219,0.656,0.486L24.757,17.988z
          M24.757,21.539c0,0.268-0.293,0.484-0.656,0.484H6.566c-0.363,0-0.658-0.217-0.658-0.484v-0.807
          c0-0.268,0.295-0.486,0.658-0.486h17.535c0.363,0,0.656,0.219,0.656,0.486L24.757,21.539z
          M15.84,25.055c0,0.266-0.155,0.48-0.347,0.48H6.255c-0.192,0-0.348-0.215-0.348-0.48v-0.809
          c0-0.266,0.155-0.484,0.348-0.484h9.238c0.191,0,0.347,0.219,0.347,0.484V25.055z
          M12.364,11.391L10.68,5.416l-1.906,5.975H8.087c0,0-2.551-7.621-2.759-7.902
          C5.194,3.295,4.99,3.158,4.719,3.076V2.742h3.783v0.334c-0.257,0-0.434,0.041-0.529,0.125
          s-0.144,0.18-0.144,0.287c0,0.102,1.354,4.193,1.354,4.193l1.058-3.279c0,0-0.379-0.947-0.499-1.072
          C9.621,3.209,9.434,3.123,9.182,3.076V2.742h3.84v0.334c-0.301,0.018-0.489,0.065-0.569,0.137
          c-0.08,0.076-0.12,0.182-0.12,0.32c0,0.131,1.291,4.148,1.291,4.148s1.171-3.74,1.171-3.896
          c0-0.234-0.051-0.404-0.153-0.514c-0.101-0.107-0.299-0.172-0.592-0.195V2.742h2.22v0.334
          c-0.245,0.035-0.442,0.133-0.585,0.291c-0.146,0.158-2.662,8.023-2.662,8.023h-0.66V11.391z
          M24.933,4.67c0,0.266-0.131,0.482-0.293,0.482h-7.79c-0.162,0-0.293-0.217-0.293-0.482V3.861
          c0-0.266,0.131-0.482,0.293-0.482h7.79c0.162,0,0.293,0.217,0.293,0.482V4.67z
          M24.997,10.662c0,0.268-0.131,0.48-0.292,0.48h-7.791c-0.164,0-0.293-0.213-0.293-0.48V9.854
          c0-0.266,0.129-0.484,0.293-0.484h7.791c0.161,0,0.292,0.219,0.292,0.484V10.662z
          M24.965,7.676c0,0.268-0.129,0.482-0.293,0.482h-7.79c-0.162,0-0.293-0.215-0.293-0.482
          V6.869c0-0.268,0.131-0.484,0.293-0.484h7.79c0.164,0,0.293,0.217,0.293,0.484V7.676z"
        />
      </g>
    </svg>
    </div>
  </button>

    ${privacyToggleHtml}
    ${editButtonHtml}

    </div>

    <!-- Edit Form (initially hidden) -->
    <div id="edit-form-container" class="hidden" style="display: none;">
      <div class="scroller">
        <form id="edit-source-form">
          <div class="form-header">
            <h2 style="color: #EF8D34;">Edit Library Record</h2>
            <p class="form-subtitle">Update the details for this book</p>
          </div>

          <!-- BibTeX Section -->
          <div class="form-section">
            <label for="edit-bibtex">BibTeX Details (optional)</label>
            <textarea id="edit-bibtex" name="bibtex" placeholder="Auto-generated from form data..."></textarea>
            <div class="field-hint">Auto-updated when you save changes</div>
          </div>

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

          <!-- Required Fields Section -->
          <div class="form-section">            
            <label for="edit-title" class="required">Title <span class="required-indicator">*</span></label>
            <input type="text" id="edit-title" name="title" required placeholder="Enter document title">
            <div id="edit-title-validation" class="validation-message"></div>
          </div>

          <!-- Optional Fields Section -->
          <div class="form-section">
            <label for="edit-author">Author</label>
            <input type="text" id="edit-author" name="author" placeholder="Author name">

            <label for="edit-year">Year</label>
            <input type="number" id="edit-year" name="year" min="1000" max="2035" placeholder="Publication year">

            <label for="edit-url">URL</label>
            <input type="url" id="edit-url" name="url" placeholder="https://...">

            <!-- Type-specific fields with proper optional-field class -->
            <label for="edit-pages" class="optional-field" style="display: none;">Pages</label>
            <input type="text" id="edit-pages" name="pages" class="optional-field" style="display: none;" placeholder="e.g., 1-20, 45-67">

            <label for="edit-journal" class="optional-field" style="display: none;">Journal</label>
            <input type="text" id="edit-journal" name="journal" class="optional-field" style="display: none;" placeholder="Journal name">

            <label for="edit-publisher" class="optional-field" style="display: none;">Publisher</label>
            <input type="text" id="edit-publisher" name="publisher" class="optional-field" style="display: none;" placeholder="Publisher name">

            <label for="edit-school" class="optional-field" style="display: none;">School</label>
            <input type="text" id="edit-school" name="school" class="optional-field" style="display: none;" placeholder="University/School name">

            <label for="edit-note" class="optional-field" style="display: none;">Note</label>
            <input type="text" id="edit-note" name="note" class="optional-field" style="display: none;" placeholder="Additional notes">

            <label for="edit-volume" class="optional-field" style="display: none;">Volume</label>
            <input type="text" id="edit-volume" name="volume" class="optional-field" style="display: none;" placeholder="e.g., 12">

            <label for="edit-issue" class="optional-field" style="display: none;">Issue</label>
            <input type="text" id="edit-issue" name="issue" class="optional-field" style="display: none;" placeholder="e.g., 3">

            <label for="edit-booktitle" class="optional-field" style="display: none;">Book Title</label>
            <input type="text" id="edit-booktitle" name="booktitle" class="optional-field" style="display: none;" placeholder="Title of the book this chapter appears in">

            <label for="edit-chapter" class="optional-field" style="display: none;">Chapter</label>
            <input type="text" id="edit-chapter" name="chapter" class="optional-field" style="display: none;" placeholder="Chapter number or title">

            <label for="edit-editor" class="optional-field" style="display: none;">Editor</label>
            <input type="text" id="edit-editor" name="editor" class="optional-field" style="display: none;" placeholder="Editor name(s)">
          </div>

          <!-- License Section -->
          <div class="form-section">
            <label for="edit-license">Content License</label>
            <select id="edit-license" name="license">
              <option value="CC-BY-SA-4.0-NO-AI">CC BY-SA 4.0 (No AI Training) - Default</option>
              <option value="CC-BY-4.0">CC BY 4.0 (Allows AI Training)</option>
              <option value="CC-BY-NC-SA-4.0">CC BY-NC-SA 4.0 (Non-Commercial, No AI)</option>
              <option value="CC0">CC0 (Public Domain)</option>
              <option value="All-Rights-Reserved">All Rights Reserved (Private)</option>
              <option value="custom">Custom License...</option>
            </select>
            <textarea id="edit-custom-license-text" name="custom_license_text" style="display:none; margin-top: 10px;" rows="4" placeholder="Enter your custom license terms..."></textarea>
            <div class="field-hint">Choose how others can use your content. <a href="/LICENSE-CONTENT.md" target="_blank">Learn more</a></div>
          </div>

          <div class="form-actions">
            <button type="submit" id="save-edit" class="formButton">Save Changes</button>
            <button type="button" id="cancel-edit" class="formButton">Cancel</button>
          </div>
        </form>
      </div>
      <div class="mask-top"></div>
      <div class="mask-bottom"></div>
    </div>
  `;
}

export class SourceContainerManager extends ContainerManager {
  constructor(containerId, overlayId, buttonId, frozenContainerIds = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);
    this.setupSourceContainerStyles();
    this.isAnimating = false;
    this.button = document.getElementById(buttonId);
    this.isInEditMode = false; // Track if we're currently in edit mode
  }

  rebindElements() {
    // Call the parent rebindElements first
    super.rebindElements();

    // Reapply styles after finding new DOM elements
    this.setupSourceContainerStyles();
  }

  // Override parent's closeOnOverlayClick to handle edit mode
  closeOnOverlayClick() {
    if (this.isInEditMode) {
      this.hideEditForm();
    } else {
      this.closeContainer();
    }
  }

  setupSourceContainerStyles() {
    // CSS handles all styling - this method kept for compatibility
    // but no longer sets inline styles
  }

  async openContainer() {
    if (this.isAnimating || !this.container) return;
    this.isAnimating = true;

    const html = await buildSourceHtml(book);
    this.container.innerHTML = html;

    const mdBtn = this.container.querySelector("#download-md");
    const docxBtn = this.container.querySelector("#download-docx");
    const editBtn = this.container.querySelector("#edit-source");
    const privacyBtn = this.container.querySelector("#privacy-toggle");

    if (mdBtn) mdBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      exportBookAsMarkdown(book);
    });
    if (docxBtn) docxBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      exportBookAsDocxStyled(book);
    });
    if (editBtn) editBtn.addEventListener("click", () => this.handleEditClick());
    if (privacyBtn) privacyBtn.addEventListener("click", () => this.handlePrivacyToggle());

    // CSS handles all positioning and animation
    this.container.classList.remove("hidden");
    this.isOpen = true;
    window.activeContainer = this.container.id;
    this.updateState(); // Adds .open class via parent's updateState()

    this.container.addEventListener("transitionend", () => {
      this.isAnimating = false;
    }, { once: true });
  }

  closeContainer() {
    if (this.isAnimating || !this.container) return;
    this.isAnimating = true;

    this.isOpen = false;
    window.activeContainer = "main-content";
    this.updateState(); // Removes .open class via parent's updateState()

    this.container.addEventListener("transitionend", () => {
      this.container.classList.add("hidden");
      this.isAnimating = false;
    }, { once: true });
  }

  async handleEditClick() {
    console.log("Edit button clicked");

    // Check if user can edit this book
    const canEdit = await canUserEditBook(book);
    if (!canEdit) {
      alert("You don't have permission to edit this book's details.");
      return;
    }

    // Get the library record and show the edit form
    await this.showEditForm();
  }

  async handlePrivacyToggle() {
    const btn = this.container.querySelector("#privacy-toggle");
    if (!btn) return;

    const isCurrentlyPrivate = btn.dataset.isPrivate === "true";

    const message = isCurrentlyPrivate
      ? "Make this book public? Anyone can view it."
      : "Make this book private? Only you can view it.";

    if (!confirm(message)) return;

    try {
      // Get library record
      const db = await openDatabase();
      const record = await getRecord(db, "library", book);

      if (!record) {
        alert("Library record not found.");
        return;
      }

      // Update visibility status (string: 'public' or 'private')
      const newVisibility = isCurrentlyPrivate ? 'public' : 'private';
      record.visibility = newVisibility;

      // Save to IndexedDB - properly wait for the transaction to complete
      const tx = db.transaction("library", "readwrite");
      const store = tx.objectStore("library");
      await new Promise((resolve, reject) => {
        const request = store.put(record);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      // Sync to backend - use the explicit newVisibility to ensure correct value
      console.log(`📤 Syncing visibility change to backend: ${newVisibility}`);
      await this.syncLibraryRecordToBackend(record);

      // Update button
      btn.dataset.isPrivate = (!isCurrentlyPrivate).toString();
      btn.innerHTML = !isCurrentlyPrivate ? PRIVATE_SVG : PUBLIC_SVG;
      btn.title = !isCurrentlyPrivate
        ? 'Book is Private - Click to make public'
        : 'Book is Public - Click to make private';

      console.log(`✅ Book privacy updated to: ${newVisibility}`);

    } catch (error) {
      console.error("Error updating privacy status:", error);
      alert("Error updating privacy status: " + error.message);
    }
  }

  async showEditForm() {
    const db = await openDatabase();
    const record = await getRecord(db, "library", book);
    
    if (!record) {
      alert("Library record not found.");
      return;
    }

    // Hide the main content and show the edit form
    const sourceContent = this.container.querySelector("#source-content");
    const editFormContainer = this.container.querySelector("#edit-form-container");
    
    if (sourceContent && editFormContainer) {
      sourceContent.style.display = "none";
      editFormContainer.style.display = "block";
      editFormContainer.classList.remove("hidden");
      
      // SET EDIT MODE FLAG
      this.isInEditMode = true;
      
      // Pre-fill the form with current data
      this.populateEditForm(record);
      
      // Expand container to accommodate form
      this.expandForEditForm();
      
      // CRITICAL FIX: Reapply container styles now that edit form is visible
      this.setupSourceContainerStyles();
      
      // Set up form event listeners
      this.setupEditFormListeners(record);
    }
  }

  populateEditForm(record) {
    // Basic fields
    const titleField = this.container.querySelector("#edit-title");
    const authorField = this.container.querySelector("#edit-author");
    const yearField = this.container.querySelector("#edit-year");
    const urlField = this.container.querySelector("#edit-url");
    const bibtexField = this.container.querySelector("#edit-bibtex");
    const licenseField = this.container.querySelector("#edit-license");
    const customLicenseField = this.container.querySelector("#edit-custom-license-text");

    const volumeField = this.container.querySelector("#edit-volume");
    const issueField2 = this.container.querySelector("#edit-issue");
    const booktitleField = this.container.querySelector("#edit-booktitle");
    const chapterField = this.container.querySelector("#edit-chapter");
    const editorField = this.container.querySelector("#edit-editor");

    if (titleField) titleField.value = record.title || "";
    if (authorField) authorField.value = record.author || record.creator || "";
    if (yearField) yearField.value = record.year || "";
    if (urlField) urlField.value = record.url || "";
    if (bibtexField) bibtexField.value = record.bibtex || "";
    if (volumeField) volumeField.value = record.volume || "";
    if (issueField2) issueField2.value = record.issue || "";
    if (booktitleField) booktitleField.value = record.booktitle || "";
    if (chapterField) chapterField.value = record.chapter || "";
    if (editorField) editorField.value = record.editor || "";

    // License fields
    if (licenseField) {
      licenseField.value = record.license || 'CC-BY-SA-4.0-NO-AI';
      // Show custom license textarea if license is custom
      if (record.license === 'custom' && customLicenseField) {
        customLicenseField.style.display = 'block';
        customLicenseField.value = record.custom_license_text || '';
      }
    }
    
    // Set the correct radio button for type
    const typeRadios = this.container.querySelectorAll('input[name="type"]');
    const recordType = record.type || "book";
    typeRadios.forEach(radio => {
      radio.checked = radio.value === recordType;
    });
    
    // Show optional fields based on type
    this.showOptionalFieldsForType(recordType, record);
  }

  showOptionalFieldsForType(type, record = {}) {
    // Hide all optional fields first (like the original showFieldsForType)
    this.container.querySelectorAll('.optional-field').forEach(field => {
      field.style.display = 'none';
      // Also hide the label (previous sibling)
      if (field.previousElementSibling && field.previousElementSibling.classList.contains('optional-field')) {
        field.previousElementSibling.style.display = 'none';
      }
    });

    // Show fields based on type (same logic as newBookForm.js)
    if (type === 'article') {
      const journal = this.container.querySelector('#edit-journal');
      const journalLabel = this.container.querySelector('label[for="edit-journal"]');
      const pages = this.container.querySelector('#edit-pages');
      const pagesLabel = this.container.querySelector('label[for="edit-pages"]');
      const volume = this.container.querySelector('#edit-volume');
      const volumeLabel = this.container.querySelector('label[for="edit-volume"]');
      const issue = this.container.querySelector('#edit-issue');
      const issueLabel = this.container.querySelector('label[for="edit-issue"]');

      if (journal && journalLabel) {
        journal.style.display = 'block';
        journalLabel.style.display = 'block';
        journal.value = record.journal || '';
      }
      if (volume && volumeLabel) {
        volume.style.display = 'block';
        volumeLabel.style.display = 'block';
        volume.value = record.volume || '';
      }
      if (issue && issueLabel) {
        issue.style.display = 'block';
        issueLabel.style.display = 'block';
        issue.value = record.issue || '';
      }
      if (pages && pagesLabel) {
        pages.style.display = 'block';
        pagesLabel.style.display = 'block';
        pages.value = record.pages || '';
      }
    } else if (type === 'book') {
      const publisher = this.container.querySelector('#edit-publisher');
      const publisherLabel = this.container.querySelector('label[for="edit-publisher"]');

      if (publisher && publisherLabel) {
        publisher.style.display = 'block';
        publisherLabel.style.display = 'block';
        publisher.value = record.publisher || '';
      }
    } else if (type === 'incollection') {
      const booktitle = this.container.querySelector('#edit-booktitle');
      const booktitleLabel = this.container.querySelector('label[for="edit-booktitle"]');
      const editor = this.container.querySelector('#edit-editor');
      const editorLabel = this.container.querySelector('label[for="edit-editor"]');
      const publisher = this.container.querySelector('#edit-publisher');
      const publisherLabel = this.container.querySelector('label[for="edit-publisher"]');
      const pages = this.container.querySelector('#edit-pages');
      const pagesLabel = this.container.querySelector('label[for="edit-pages"]');
      const chapter = this.container.querySelector('#edit-chapter');
      const chapterLabel = this.container.querySelector('label[for="edit-chapter"]');

      if (booktitle && booktitleLabel) {
        booktitle.style.display = 'block';
        booktitleLabel.style.display = 'block';
        booktitle.value = record.booktitle || '';
      }
      if (editor && editorLabel) {
        editor.style.display = 'block';
        editorLabel.style.display = 'block';
        editor.value = record.editor || '';
      }
      if (publisher && publisherLabel) {
        publisher.style.display = 'block';
        publisherLabel.style.display = 'block';
        publisher.value = record.publisher || '';
      }
      if (chapter && chapterLabel) {
        chapter.style.display = 'block';
        chapterLabel.style.display = 'block';
        chapter.value = record.chapter || '';
      }
      if (pages && pagesLabel) {
        pages.style.display = 'block';
        pagesLabel.style.display = 'block';
        pages.value = record.pages || '';
      }
    } else if (type === 'phdthesis') {
      const school = this.container.querySelector('#edit-school');
      const schoolLabel = this.container.querySelector('label[for="edit-school"]');

      if (school && schoolLabel) {
        school.style.display = 'block';
        schoolLabel.style.display = 'block';
        school.value = record.school || '';
      }
    } else if (type === 'misc') {
      const note = this.container.querySelector('#edit-note');
      const noteLabel = this.container.querySelector('label[for="edit-note"]');

      if (note && noteLabel) {
        note.style.display = 'block';
        noteLabel.style.display = 'block';
        note.value = record.note || '';
      }
    }
  }


  populateFieldsFromBibtex() {
    const bibtexField = this.container.querySelector('#edit-bibtex');
    if (!bibtexField) return;
    
    const bibtexText = bibtexField.value.trim();
    if (!bibtexText) return;

    const patterns = {
      title: /title\s*=\s*[{"]([^}"]+)[}"]/i,
      author: /author\s*=\s*[{"]([^}"]+)[}"]/i,
      journal: /journal\s*=\s*[{"]([^}"]+)[}"]/i,
      year: /year\s*=\s*[{"]?(\d+)[}"]?/i,
      pages: /pages\s*=\s*[{"]([^}"]+)[}"]/i,
      publisher: /publisher\s*=\s*[{"]([^}"]+)[}"]/i,
      school: /school\s*=\s*[{"]([^}"]+)[}"]/i,
      note: /note\s*=\s*[{"]([^}"]+)[}"]/i,
      url: /url\s*=\s*[{"]([^}"]+)[}"]/i,
      volume: /volume\s*=\s*[{"]([^}"]+)[}"]/i,
      issue: /number\s*=\s*[{"]([^}"]+)[}"]/i,
      booktitle: /booktitle\s*=\s*[{"]([^}"]+)[}"]/i,
      chapter: /chapter\s*=\s*[{"]([^}"]+)[}"]/i,
      editor: /editor\s*=\s*[{"]([^}"]+)[}"]/i
    };

    let changed = false;
    Object.entries(patterns).forEach(([field, pattern]) => {
      const match = bibtexText.match(pattern);
      if (match) {
        const element = this.container.querySelector(`#edit-${field}`);
        if (element) {
          let newVal = match[1].trim();
          
          // Auto-format URL if it's a URL field
          if (field === 'url' && newVal && !newVal.match(/^https?:\/\//i)) {
            newVal = `https://${newVal}`;
          }
          
          if (element.value !== newVal) {
            element.value = newVal;
            changed = true;
          }
        }
      }
    });

    // If fields were updated programmatically, trigger their validation listeners
    if (changed) {
      const title = this.container.querySelector('#edit-title');
      if (title) title.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  cleanUrl(url) {
    if (!url) return url;

    try {
      const urlObj = new URL(url);

      // Common tracking parameters to remove
      const trackingParams = [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid',
        '_ga', '_gl', 'ref', 'source', 'referrer'
      ];

      // Remove tracking parameters
      trackingParams.forEach(param => {
        urlObj.searchParams.delete(param);
      });

      return urlObj.toString();
    } catch (e) {
      // If URL is invalid, return as-is
      return url;
    }
  }

  validateUrl(value) {
    if (!value) return { valid: true, message: '' }; // Optional field

    // Auto-format URL if it doesn't have a protocol
    let formattedUrl = value.trim();
    if (formattedUrl && !formattedUrl.match(/^https?:\/\//i)) {
      formattedUrl = `https://${formattedUrl}`;
    }

    // Clean tracking parameters from URL
    formattedUrl = this.cleanUrl(formattedUrl);

    try {
      new URL(formattedUrl);
      return { valid: true, message: 'Valid URL', formattedValue: formattedUrl };
    } catch (e) {
      return { valid: false, message: 'Please enter a valid URL (e.g., example.com or https://example.com)' };
    }
  }


  expandForEditForm() {
    // Expand container for edit form (override CSS width temporarily)
    const isMobile = window.innerWidth <= 480;
    const w = isMobile ? Math.min(window.innerWidth - 30, 400) : 400;
    const h = Math.min(window.innerHeight * 0.9, 700);

    this.container.style.width = `${w}px`;
    this.container.style.height = `${h}px`;
  }

  setupEditFormListeners(record) {
    const form = this.container.querySelector("#edit-source-form");
    const cancelBtn = this.container.querySelector("#cancel-edit");
    const typeRadios = this.container.querySelectorAll('input[name="type"]');

    const bibtexField = this.container.querySelector("#edit-bibtex");
    const urlField = this.container.querySelector("#edit-url");
    const licenseField = this.container.querySelector("#edit-license");
    const customLicenseField = this.container.querySelector("#edit-custom-license-text");

    // License dropdown listener to show/hide custom license textarea
    if (licenseField && customLicenseField) {
      licenseField.addEventListener('change', (e) => {
        if (e.target.value === 'custom') {
          customLicenseField.style.display = 'block';
        } else {
          customLicenseField.style.display = 'none';
        }
      });
    }

    // Type change listeners for radio buttons
    typeRadios.forEach(radio => {
      radio.addEventListener("change", (e) => {
        if (e.target.checked) {
          this.showOptionalFieldsForType(e.target.value, record);
        }
      });
    });
    

    // URL field auto-formatting
    if (urlField) {
      urlField.addEventListener('blur', () => {
        const result = this.validateUrl(urlField.value);
        
        // Auto-format the URL in the input field if validation succeeded
        if (result.valid && result.formattedValue && result.formattedValue !== urlField.value) {
          urlField.value = result.formattedValue;
        }
      });
    }
    
    // BibTeX field listeners (same as newBookForm.js)
    if (bibtexField) {
      // Helper to trigger validation after autofill
      const triggerAutoValidation = () => {
        const titleField = this.container.querySelector("#edit-title");
        if (titleField) titleField.dispatchEvent(new Event('input', { bubbles: true }));
      };

      bibtexField.addEventListener('paste', (e) => {
        setTimeout(() => {
          const bibtexText = bibtexField.value;
          const typeMatch = bibtexText.match(/@(\w+)\s*\{/i);
          
          if (typeMatch) {
            const bibType = typeMatch[1].toLowerCase();
            const radio = this.container.querySelector(`input[name="type"][value="${bibType}"]`);
            
            if (radio) {
              radio.checked = true;
              this.showOptionalFieldsForType(bibType, record);
            } else {
              const miscRadio = this.container.querySelector('input[name="type"][value="misc"]');
              if (miscRadio) {
                miscRadio.checked = true;
                this.showOptionalFieldsForType('misc', record);
              }
            }
            
            setTimeout(() => {
              this.populateFieldsFromBibtex();
              triggerAutoValidation();
            }, 50);
          }
        }, 0);
      });

      bibtexField.addEventListener('input', () => {
        clearTimeout(bibtexField.debounceTimer);
        bibtexField.debounceTimer = setTimeout(() => {
          const bibtexText = bibtexField.value;
          const typeMatch = bibtexText.match(/@(\w+)\s*\{/i);
          
          if (typeMatch) {
            const bibType = typeMatch[1].toLowerCase();
            const radio = this.container.querySelector(`input[name="type"][value="${bibType}"]`);
            
            if (radio) {
              radio.checked = true;
              this.showOptionalFieldsForType(bibType, record);
              this.populateFieldsFromBibtex();
              triggerAutoValidation();
            }
          }
        }, 300);
      });
    }
    

    // Cancel button
    if (cancelBtn) {
      cancelBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hideEditForm();
      });
    }
    
    // Form submission
    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        await this.handleFormSubmit(record);
      });
    }
  }

  hideEditForm() {
    // CLEAR EDIT MODE FLAG
    this.isInEditMode = false;
    
    const sourceContent = this.container.querySelector("#source-content");
    const editFormContainer = this.container.querySelector("#edit-form-container");
    
    if (sourceContent && editFormContainer) {
      sourceContent.style.display = "block";
      editFormContainer.style.display = "none";
      editFormContainer.classList.add("hidden");
      
      // Reset to CSS dimensions by removing inline width/height
      this.container.style.width = "";
      this.container.style.height = "";
      
      // RE-ATTACH EVENT LISTENERS: Make sure buttons work after returning from edit form
      const mdBtn = this.container.querySelector("#download-md");
      const docxBtn = this.container.querySelector("#download-docx");
      const editBtn = this.container.querySelector("#edit-source");
      
      if (mdBtn) mdBtn.addEventListener("click", () => exportBookAsMarkdown(book));
      if (docxBtn) docxBtn.addEventListener("click", () => exportBookAsDocxStyled(book));
      if (editBtn) editBtn.addEventListener("click", () => this.handleEditClick());
    }
  }

  async handleFormSubmit(originalRecord) {
    try {
      // Collect form data
      const formData = this.collectFormData();

      // Ensure book ID is available for BibTeX generation (used as citation key)
      formData.book = originalRecord.book;

      // Always regenerate BibTeX from form data to ensure all fields are included
      const finalBibtex = await generateBibtexFromForm(formData);
      console.log("🔄 Regenerated BibTeX from form data:", finalBibtex);


      // Update the record with new data AND regenerated BibTeX
      const updatedRecord = {
        ...originalRecord,
        ...formData,
        bibtex: finalBibtex,
        timestamp: Date.now(), // Update timestamp when record is modified

        book: originalRecord.book, // Keep original book ID (primary key)
      };
      
      // 🧹 Clean the record before saving to prevent payload bloat
      const cleanedRecord = prepareLibraryForIndexedDB(updatedRecord);

      // Save to IndexedDB
      const db = await openDatabase();
      const tx = db.transaction("library", "readwrite");
      const store = tx.objectStore("library");
      await store.put(cleanedRecord);

      console.log("Library record updated successfully:", cleanedRecord);

      console.log("Final BibTeX:", finalBibtex);

      // Sync to backend database
      try {
        await this.syncLibraryRecordToBackend(cleanedRecord);
        console.log("✅ Library record synced to backend successfully");
      } catch (syncError) {
        console.warn("⚠️ Backend sync failed, but local update succeeded:", syncError);
        // Don't fail the entire operation if backend sync fails
      }

      
      // Hide the form and refresh the container content
      this.hideEditForm();
      
      // Refresh the citation display
      await this.refreshCitationDisplay();
      
      alert("Library record updated successfully!");
      
    } catch (error) {
      console.error("Error updating library record:", error);
      alert("Error updating library record: " + error.message);
    }
  }


  async syncLibraryRecordToBackend(libraryRecord) {
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

    // 🧹 Clean the library record and prepare raw_json for PostgreSQL
    const cleanedForSync = {
      ...libraryRecord,
      raw_json: JSON.stringify(cleanLibraryItemForStorage(libraryRecord))
    };

    const response = await fetch('/api/db/library/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-TOKEN': csrfToken,
      },
      credentials: 'include',
      body: JSON.stringify({
        data: cleanedForSync // The upsert endpoint expects a single record in the data field

      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Backend sync failed: ${response.status} - ${errorText}`);
    }

    return await response.json();
  }


  collectFormData() {
    const form = this.container.querySelector("#edit-source-form");
    const formData = new FormData(form);
    const data = {};
    
    for (let [key, value] of formData.entries()) {
      data[key] = value;
    }
    
    // Make sure we get the selected radio button type
    const checkedTypeRadio = this.container.querySelector('input[name="type"]:checked');
    if (checkedTypeRadio) {
      data.type = checkedTypeRadio.value;
    }
    

    // Collect all fields including BibTeX and license
    const allFields = ["title", "author", "year", "url", "bibtex", "journal", "pages", "publisher", "school", "note", "volume", "issue", "booktitle", "chapter", "editor", "license", "custom_license_text"];
    allFields.forEach(fieldName => {
      const field = this.container.querySelector(`#edit-${fieldName.replace('_', '-')}`);
      if (field) {
        data[fieldName] = field.value || '';
      }
    });

    return data;
  }

  async refreshCitationDisplay() {
    // Rebuild the HTML with updated citation
    const html = await buildSourceHtml(book);
    this.container.innerHTML = html;
    
    // Re-attach event listeners
    const mdBtn = this.container.querySelector("#download-md");
    const docxBtn = this.container.querySelector("#download-docx");
    const editBtn = this.container.querySelector("#edit-source");
    
    if (mdBtn) mdBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      exportBookAsMarkdown(book);
    });
    if (docxBtn) docxBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      exportBookAsDocxStyled(book);
    });
    if (editBtn) editBtn.addEventListener("click", () => this.handleEditClick());
  }
}

// This instance is created only ONCE.
const sourceManager = new SourceContainerManager(
  "source-container",
  "ref-overlay",
  "cloudRef",
  ["main-content"]
);
export default sourceManager;

// Destroy function for cleanup during navigation
export function destroySourceManager() {
  if (sourceManager) {
    console.log('🧹 Destroying source container manager');
    sourceManager.destroy();
    return true;
  }
  return false;
}


let _TurndownService = null;
async function loadTurndown() {
  if (_TurndownService) return _TurndownService;
  // Skypack will auto-optimize to an ES module
  const mod = await import('https://cdn.skypack.dev/turndown');
  // turndown's default export is the constructor
  _TurndownService = mod.default;
  return _TurndownService;
}

let _Docx = null;
async function loadDocxLib() {
  if (_Docx) return _Docx;
  // Skypack serves this as a proper ES module with CORS headers
  const mod = await import('https://cdn.skypack.dev/docx@8.3.0');
  // The module exports Document, Packer, Paragraph, etc.
  _Docx = mod;
  return _Docx;
}

let _htmlToText = null;
async function loadHtmlToText() {
  if (_htmlToText) return _htmlToText;
  const mod = await import('https://cdn.skypack.dev/html-to-text');
  _htmlToText = mod.htmlToText;
  return _htmlToText;
}

/**
 * Fetches all nodes for a book, converts to markdown,
 * and returns a single string.
 */
async function buildMarkdownForBook(bookId = book || 'latest') {
  // 1) get raw chunks
  const chunks = await getNodeChunksFromIndexedDB(bookId);
  // 2) sort by chunk_id
  chunks.sort((a,b) => a.chunk_id - b.chunk_id);
  // 3) load converter
  const Turndown = await loadTurndown();
  const turndownService = new Turndown();
  // 4) convert each chunk.html (or chunk.content) → md
  const mdParts = chunks.map(chunk =>
    turndownService.turndown(chunk.content || chunk.html)
  );
  // 5) join with double newlines
  return mdParts.join('\n\n');
}

async function buildHtmlForBook(bookId = book || 'latest') {
  const chunks = await getNodeChunksFromIndexedDB(bookId);
  chunks.sort((a, b) => a.chunk_id - b.chunk_id);
  // assume chunk.content contains valid inner-HTML of each <div>
  const body = chunks.map(c => c.content || c.html).join('\n');
  // wrap in minimal docx‐friendly HTML
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8"/>
    <title>Book ${bookId}</title>
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

async function buildDocxBuffer(bookId = book || 'latest') {
  const { Document, Packer, Paragraph, TextRun } = await loadDocxLib();
  const htmlToText = await loadHtmlToText();
  const chunks = await getNodeChunksFromIndexedDB(bookId);
  chunks.sort((a, b) => a.chunk_id - b.chunk_id);

  // Flatten all HTML → plaintext (you can also parse tags more richly)
  const paragraphs = chunks.map(chunk => {
    const plaintext = htmlToText(chunk.content || chunk.html, {
      wordwrap: false,
      selectors: [{ selector: 'a', options: { ignoreHref: true } }],
    });
    return new Paragraph({
      children: [new TextRun(plaintext)],
    });
  });

  const doc = new Document({
    sections: [{ properties: {}, children: paragraphs }],
  });

  // Packer.toBlob returns a Blob suitable for download
  return Packer.toBlob(doc);
}

/**
 * Public helper: build + download in one go.
 */
async function exportBookAsMarkdown(bookId = book || 'latest') {
  try {
    const md = await buildMarkdownForBook(bookId);
    const filename = `book-${bookId}.md`;
    downloadMarkdown(filename, md);
    console.log(`✅ Markdown exported to ${filename}`);
  } catch (err) {
    console.error('❌ Failed to export markdown:', err);
  }
}

async function exportBookAsDocx(bookId = book || 'latest') {
  try {
    const blob = await buildDocxBuffer(bookId);
    const filename = `book-${bookId}.docx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    console.log(`✅ DOCX exported to ${filename}`);
  } catch (err) {
    console.error('❌ Failed to export .docx:', err);
  }
}

/**
 * Triggers a download in the browser of the given text as a .md file.
 */
function downloadMarkdown(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

//


// Walk a DOM node and return either Paragraphs or Runs.
// Runs of type TextRun must be created with their styling flags upfront.
function htmlElementToDocx(node, docxComponents) {
  const { TextRun, Paragraph, HeadingLevel, ExternalHyperlink } = docxComponents;
  const out = [];

  node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      // plain text
      out.push(
        new TextRun({
          text: child.textContent,
        })
      );
    }
    else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();

      switch (tag) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6': {
          const level = {
            h1: HeadingLevel.HEADING_1,
            h2: HeadingLevel.HEADING_2,
            h3: HeadingLevel.HEADING_3,
            h4: HeadingLevel.HEADING_4,
            h5: HeadingLevel.HEADING_5,
            h6: HeadingLevel.HEADING_6,
          }[tag];
          out.push(
            new Paragraph({
              text: child.textContent,
              heading: level,
            })
          );
          break;
        }

        case 'strong':
        case 'b': {
          // Bold: each text node under here becomes a bold run
          child.childNodes.forEach(n => {
            if (n.nodeType === Node.TEXT_NODE) {
              out.push(
                new TextRun({
                  text: n.textContent,
                  bold: true,
                })
              );
            } else {
              // nested tags: recurse and mark bold on each run
              htmlElementToDocx(n, docxComponents).forEach(run => {
                if (run instanceof TextRun) {
                  out.push(
                    new TextRun({
                      text: run.text,
                      bold: true,
                      italics: run.italics,
                    })
                  );
                } else {
                  out.push(run);
                }
              });
            }
          });
          break;
        }

        case 'em':
        case 'i': {
          child.childNodes.forEach(n => {
            if (n.nodeType === Node.TEXT_NODE) {
              out.push(
                new TextRun({
                  text: n.textContent,
                  italics: true,
                })
              );
            } else {
              htmlElementToDocx(n, docxComponents).forEach(run => {
                if (run instanceof TextRun) {
                  out.push(
                    new TextRun({
                      text: run.text,
                      italics: true,
                      bold: run.bold,
                    })
                  );
                } else {
                  out.push(run);
                }
              });
            }
          });
          break;
        }

        case 'a': {
          const url = child.getAttribute('href') || '';
          const text = child.textContent;
          out.push(
            new ExternalHyperlink({
              link: url,
              children: [
                new TextRun({
                  text,
                  style: 'Hyperlink',
                }),
              ],
            })
          );
          break;
        }

        case 'br': {
          out.push(new TextRun({ text: '\n' }));
          break;
        }

        default:
          // everything else: recurse inline
          htmlElementToDocx(child, docxComponents).forEach(item => out.push(item));
      }
    }
  });

  return out;
}

// Build the docx with styled runs/headings/links
async function buildDocxWithStyles(bookId = book || 'latest') {
  const docxLib = await loadDocxLib();
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink } = docxLib;
  const chunks = await getNodeChunksFromIndexedDB(bookId);
  chunks.sort((a,b) => a.chunk_id - b.chunk_id);

  const parser = new DOMParser();
  const children = [];

  for (const chunk of chunks) {
    const frag = parser.parseFromString(
      `<div>${chunk.content||chunk.html}</div>`,
      'text/html'
    ).body.firstChild;

    // collect Runs and Paragraphs
    const runsAndParas = htmlElementToDocx(frag, { TextRun, Paragraph, HeadingLevel, ExternalHyperlink });

    // group Runs into Paragraphs
    let buf = [];
    runsAndParas.forEach(item => {
      if (item instanceof Paragraph) {
        if (buf.length) {
          children.push(new Paragraph({ children: buf }));
          buf = [];
        }
        children.push(item);
      } else {
        buf.push(item);
      }
    });
    if (buf.length) {
      children.push(new Paragraph({ children: buf }));
    }
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });
  return Packer.toBlob(doc);
}

async function exportBookAsDocxStyled(bookId = book || 'latest') {
  try {
    const blob = await buildDocxWithStyles(bookId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `book-${bookId}.docx`;
    a.click();
    URL.revokeObjectURL(url);
    console.log('✅ Styled DOCX exported');
  } catch (e) {
    console.error('❌ export styled docx failed', e);
  }
}

// Store handler reference for proper cleanup (like logoNav pattern)
let sourceClickHandler = null;

export function initializeSourceButtonListener() {
  sourceManager.rebindElements();

  if (!sourceManager.button) {
    console.warn("Source button #cloudRef not found by manager. Cannot attach listener.");
    return;
  }

  if (sourceManager.button.dataset.sourceListenerAttached) {
    return;
  }

  // Store handler reference
  sourceClickHandler = (e) => {
    e.preventDefault();
    sourceManager.toggleContainer();
  };

  sourceManager.button.addEventListener("click", sourceClickHandler);
  sourceManager.button.dataset.sourceListenerAttached = "true";
  log.init('Source button listener attached', '/components/sourceButton.js');
}

/**
 * Destroy source button listener
 * Properly removes event listener to prevent accumulation
 */
export function destroySourceButtonListener() {
  if (sourceManager && sourceManager.button) {
    // ✅ CRITICAL FIX: Remove actual listener
    if (sourceClickHandler) {
      sourceManager.button.removeEventListener("click", sourceClickHandler);
      sourceClickHandler = null;
    }
    delete sourceManager.button.dataset.sourceListenerAttached;
  }
}
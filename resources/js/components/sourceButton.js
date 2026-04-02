import { ContainerManager } from "../containerManager.js";
import { log, verbose } from "../utilities/logger.js";
import { openDatabase, getNodeChunksFromIndexedDB, prepareLibraryForIndexedDB, cleanLibraryItemForStorage } from "../indexedDB/index.js";
import { formatBibtexToCitation, generateBibtexFromForm } from "../utilities/bibtexProcessor.js";
import { book } from "../app.js";
import { canUserEditBook, clearEditPermissionCache, getAuthContextSync } from "../utilities/auth.js";

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

function formatRelativeTime(isoString) {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

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

    ${canEdit ? (() => {
      const authCtx = getAuthContextSync();
      const isLoggedIn = authCtx?.isLoggedIn;
      const isPremium = authCtx?.user?.status === 'premium';

      let btnHtml = '';
      if (!isLoggedIn) {
        btnHtml = `
          <button type="button" id="ai-review-btn" disabled style="width: 100%; padding: 8px 12px; font-size: 13px; color: #888; border: 1px solid rgba(136,136,136,0.4); background: transparent; border-radius: 4px; cursor: not-allowed; display: flex; align-items: center; justify-content: center; gap: 6px; opacity: 0.6;">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            AI Citation Review
          </button>
          <p style="font-size: 11px; color: #666; margin-top: 6px;">Must be logged in.</p>`;
      } else if (!isPremium) {
        btnHtml = `
          <button type="button" id="ai-review-btn" disabled style="width: 100%; padding: 8px 12px; font-size: 13px; color: #888; border: 1px solid rgba(136,136,136,0.4); background: transparent; border-radius: 4px; cursor: not-allowed; display: flex; align-items: center; justify-content: center; gap: 6px; opacity: 0.6;">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            AI Citation Review
          </button>
          <p style="font-size: 11px; color: #666; margin-top: 6px;">Currently only for premium users. Email <a href="mailto:team@hyperlit.io" style="color: #4EACAE;">team@hyperlit.io</a> if you are interested.</p>`;
      } else {
        btnHtml = `
          <button type="button" id="ai-review-btn" style="width: 100%; padding: 8px 12px; font-size: 13px; color: #EF8D34; border: 1px solid rgba(239,141,52,0.4); background: transparent; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            AI Citation Review
          </button>
          <div id="ai-review-info" style="display: none; margin-top: 10px;">
            <p style="font-size: 12px; color: #aaa; margin: 0 0 10px 0; line-height: 1.5;">AI Citation Review compares all citations in this text to open databases, pulling any available data. It then compares the truth claim of each citation to the source material. The review takes 10-15 minutes. You will be emailed on completion.</p>
            <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: #aaa; margin-bottom: 10px; cursor: pointer;">
              <input type="checkbox" id="ai-review-force" style="accent-color: #EF8D34;" />
              Rescan all sources from scratch
            </label>
            <button type="button" id="ai-review-generate" style="width: 100%; padding: 8px 12px; font-size: 13px; color: #221F20; background: #EF8D34; border: none; border-radius: 4px; cursor: pointer; font-family: inherit;">Generate Review</button>
          </div>`;
      }

      return `<div id="ai-review-section" data-lib-timestamp="${record?.timestamp || 0}" style="margin-top: 15px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 15px;">
        <h3 style="font-size: 13px; color: #888; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 0.5px;">AI Citation Review</h3>
        ${btnHtml}
      </div>`;
    })() : ''}

    ${canEdit ? `<div id="version-history-section" style="margin-top: 20px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 15px;">
      <h3 style="font-size: 13px; color: #888; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 0.5px;">Version History</h3>
      <div id="version-history-list" style="font-size: 13px; color: #aaa;">Loading...</div>
    </div>` : ''}

    ${await (async () => {
      if (!canEdit || accessDenied) return '';
      try {
        const resp = await fetch(`/api/books/${encodeURIComponent(book)}/reconvert-info`, { credentials: 'include' });
        if (!resp.ok) return '';
        const info = await resp.json();
        if (!info.canReconvert) return '';
        const label = info.hasOcrCache ? 'Reconvert from OCR cache' : 'Reconvert from source';
        return `
          <div id="reconvert-section" style="margin-top: 15px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 15px;">
            <button type="button" id="reconvert-btn" style="width: 100%; padding: 8px 12px; font-size: 13px; color: #EF8D34; border: 1px solid rgba(239,141,52,0.4); background: transparent; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="1 4 1 10 7 10"></polyline>
                <polyline points="23 20 23 14 17 14"></polyline>
                <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path>
              </svg>
              ${label}
            </button>
            <p style="font-size: 11px; color: #666; margin-top: 6px;">Re-process from source files. Existing content will be replaced.</p>
          </div>`;
      } catch (e) {
        console.warn('Could not check reconvert availability:', e);
        return '';
      }
    })()}

    ${(canEdit && !accessDenied) ? `
    <div id="reupload-section" style="margin-top: 15px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 15px;">
      <h3 style="font-size: 13px; color: #888; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 0.5px;">Re-upload Source</h3>
      <div id="reupload-dropzone" style="border: 2px dashed rgba(136,136,136,0.4); border-radius: 6px; padding: 20px 12px; text-align: center; cursor: pointer; transition: border-color 0.2s;">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 8px;">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p style="font-size: 12px; color: #aaa; margin: 0 0 4px 0;">Drag & drop a file or click to select</p>
        <p style="font-size: 11px; color: #666; margin: 0;">md, doc, docx, epub, html, pdf</p>
      </div>
      <input type="file" id="reupload-file-input" accept=".md,.doc,.docx,.epub,.html,.pdf" style="display: none;">
      <p id="reupload-status" style="font-size: 12px; color: #d73a49; margin-top: 6px; display: none;"></p>
    </div>` : ''}

    ${(canEdit && !accessDenied && record) ? `
    <div id="delete-book-section" style="margin-top: 20px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 15px;">
      <button type="button" id="delete-book-btn" style="width: 100%; padding: 8px 12px; font-size: 13px; color: #d73a49; border: 1px solid rgba(215,58,73,0.4); background: transparent; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>
        Delete Book
      </button>
      <p style="font-size: 11px; color: #666; margin-top: 6px;">Permanently delete this book and all associated data.</p>
    </div>` : ''}

    </div>

    ${privacyToggleHtml}
    ${editButtonHtml}

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

  attachInternalListeners() {
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

    const reconvertBtn = this.container.querySelector("#reconvert-btn");
    if (reconvertBtn) reconvertBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleReconvert();
    });

    const deleteBtn = this.container.querySelector("#delete-book-btn");
    if (deleteBtn) deleteBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleDeleteBook();
    });

    // Re-upload drop zone
    const dropzone = this.container.querySelector("#reupload-dropzone");
    const fileInput = this.container.querySelector("#reupload-file-input");
    if (dropzone && fileInput) {
      dropzone.addEventListener("click", () => fileInput.click());
      dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.style.borderColor = '#EF8D34';
      });
      dropzone.addEventListener("dragleave", () => {
        dropzone.style.borderColor = 'rgba(136,136,136,0.4)';
      });
      dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.style.borderColor = 'rgba(136,136,136,0.4)';
        const file = e.dataTransfer.files[0];
        if (file) this.handleReupload(file);
      });
      fileInput.addEventListener("change", () => {
        const file = fileInput.files[0];
        if (file) this.handleReupload(file);
        fileInput.value = '';
      });
    }

    const aiReviewBtn = this.container.querySelector("#ai-review-btn");
    if (aiReviewBtn && !aiReviewBtn.disabled) {
      aiReviewBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const infoPanel = this.container.querySelector("#ai-review-info");
        if (infoPanel) {
          infoPanel.style.display = infoPanel.style.display === 'none' ? 'block' : 'none';
        }
      });
    }

    const aiReviewGenerate = this.container.querySelector("#ai-review-generate");
    if (aiReviewGenerate) {
      aiReviewGenerate.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.handleAiReviewGenerate();
      });
    }

    this.loadVersionHistory();
    this.loadAiReviewStatus();
  }

  async loadVersionHistory() {
    const listEl = this.container.querySelector("#version-history-list");
    if (!listEl) return;

    try {
      const resp = await fetch(`/api/books/${encodeURIComponent(book)}/snapshots?limit=20`, {
        credentials: 'include'
      });

      if (!resp.ok) {
        listEl.textContent = 'Could not load version history.';
        return;
      }

      const data = await resp.json();

      if (!data.success || !data.snapshots || data.snapshots.length === 0) {
        listEl.textContent = 'No version history available yet.';
        return;
      }

      listEl.innerHTML = '';
      for (const snap of data.snapshots) {
        const a = document.createElement('a');
        a.href = `/${encodeURIComponent(book)}/timemachine?at=${encodeURIComponent(snap.changed_at)}`;
        a.className = 'version-history-item';

        const timeSpan = document.createElement('span');
        timeSpan.className = 'snapshot-time';
        timeSpan.textContent = formatRelativeTime(snap.changed_at);

        const detailSpan = document.createElement('span');
        detailSpan.className = 'snapshot-detail';
        detailSpan.textContent = `${snap.nodes_changed} node${snap.nodes_changed == 1 ? '' : 's'}`;

        a.appendChild(timeSpan);
        a.appendChild(detailSpan);
        listEl.appendChild(a);
      }
    } catch (err) {
      console.warn('Failed to load version history:', err);
      listEl.textContent = 'Could not load version history.';
    }
  }

  async openContainer() {
    if (this.isAnimating || !this.container) return;
    this.isAnimating = true;

    const html = await buildSourceHtml(book);
    this.container.innerHTML = html;

    this.attachInternalListeners();

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

    this.stopAiReviewPolling();
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

      // Keep raw_json in sync with top-level visibility
      if (record.raw_json && typeof record.raw_json === 'object') {
        record.raw_json.visibility = newVisibility;
      }

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

      clearEditPermissionCache(book);

    } catch (error) {
      console.error("Error updating privacy status:", error);
      alert("Error updating privacy status: " + error.message);
    }
  }

  async handleReconvert() {
    if (!confirm(
      'This will re-process the book from its source files.\n\n' +
      'All existing content (nodes, footnotes, references) will be replaced.\n' +
      'You can use Version History to go back if needed.\n\nContinue?'
    )) return;

    const btn = this.container.querySelector("#reconvert-btn");
    if (btn) { btn.disabled = true; btn.textContent = 'Reconverting...'; }

    try {
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
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

      // Show footnote audit if there are issues
      if (result.footnoteAudit) {
        const audit = result.footnoteAudit;
        const hasIssues = (audit.gaps?.length || 0) +
          (audit.unmatched_refs?.length || 0) +
          (audit.unmatched_defs?.length || 0) +
          (audit.duplicates?.length || 0) > 0;

        if (hasIssues) {
          const { ImportBookTransition } = await import('../navigation/pathways/ImportBookTransition.js');
          await ImportBookTransition.showFootnoteAuditModal(audit, book, { mode: 'reconvert' });
          // User dismissed modal — continue with reload
        }
      }

      // Clear IndexedDB content (keeps library record)
      const { clearBookContentFromIndexedDB } = await import('../indexedDB/index.js');
      await clearBookContentFromIndexedDB(book);

      // Reload page to show reconverted content
      window.location.reload();
    } catch (error) {
      console.error('Reconvert failed:', error);
      alert('Reconversion failed: ' + error.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Reconvert from source'; }
    }
  }

  async handleReupload(file) {
    const statusEl = this.container.querySelector("#reupload-status");
    const dropzone = this.container.querySelector("#reupload-dropzone");

    const showError = (msg) => {
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

    // PDF requires premium
    if (ext === 'pdf') {
      const authCtx = getAuthContextSync();
      if (authCtx?.user?.status !== 'premium') {
        showError('PDF import requires a premium account.');
        return;
      }
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
      dropzone.innerHTML = '<p style="font-size: 13px; color: #EF8D34; margin: 0;">Uploading &amp; converting...</p>';
    }

    try {
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
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

      // Show footnote audit modal if issues exist
      if (result.footnoteAudit) {
        const audit = result.footnoteAudit;
        const hasIssues = (audit.gaps?.length || 0) +
          (audit.unmatched_refs?.length || 0) +
          (audit.unmatched_defs?.length || 0) +
          (audit.duplicates?.length || 0) > 0;

        if (hasIssues) {
          const { ImportBookTransition } = await import('../navigation/pathways/ImportBookTransition.js');
          await ImportBookTransition.showFootnoteAuditModal(audit, book, { mode: 'reconvert' });
        }
      }

      // Clear IndexedDB content
      const { clearBookContentFromIndexedDB } = await import('../indexedDB/index.js');
      await clearBookContentFromIndexedDB(book);

      window.location.reload();
    } catch (error) {
      console.error('Re-upload failed:', error);
      showError('Re-upload failed: ' + error.message);

      // Reset dropzone
      if (dropzone) {
        dropzone.style.pointerEvents = '';
        dropzone.style.opacity = '';
        dropzone.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 8px;">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <p style="font-size: 12px; color: #aaa; margin: 0 0 4px 0;">Drag & drop a file or click to select</p>
          <p style="font-size: 11px; color: #666; margin: 0;">md, doc, docx, epub, html, pdf</p>`;
      }
    }
  }

  async handleDeleteBook() {
    // Re-check permissions
    const canEdit = await canUserEditBook(book);
    if (!canEdit) {
      alert("You don't have permission to delete this book.");
      return;
    }

    // First confirmation
    if (!confirm(`Delete "${book}" and all associated data?`)) return;

    // Second confirmation — spell out what's lost
    if (!confirm(
      'Are you sure? This will permanently delete:\n\n' +
      '- All book content (nodes, footnotes, references)\n' +
      '- The library record and citation data\n' +
      '- Any AI review results\n\n' +
      'This action cannot be undone.'
    )) return;

    const btn = this.container.querySelector("#delete-book-btn");
    if (btn) {
      btn.disabled = true;
      btn.style.cursor = 'not-allowed';
      btn.style.opacity = '0.6';
      btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
        Deleting...`;
    }

    try {
      // 1. Delete from IndexedDB
      const { deleteBookFromIndexedDB } = await import('../indexedDB/index.js');
      await deleteBookFromIndexedDB(book);

      // 2. Delete from server
      const { refreshAuth } = await import('../utilities/auth.js');
      await refreshAuth();

      const csrfToken = window.csrfToken || document.querySelector('meta[name="csrf-token"]')?.content;
      const resp = await fetch(`/api/books/${encodeURIComponent(book)}`, {
        method: 'DELETE',
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-TOKEN': csrfToken,
        },
        credentials: 'include',
      });

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`${resp.status} ${txt}`);
      }

      console.log(`Book ${book} deleted successfully.`);

      // 3. Redirect to user home
      const authCtx = getAuthContextSync();
      const username = authCtx?.user?.username;
      window.location.href = username ? `/${encodeURIComponent(username)}` : '/';

    } catch (error) {
      console.error('Delete book failed:', error);
      alert('Failed to delete book: ' + error.message);
      if (btn) {
        btn.disabled = false;
        btn.style.cursor = 'pointer';
        btn.style.opacity = '1';
        btn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
          Delete Book`;
      }
    }
  }

  async handleAiReviewGenerate() {
    const generateBtn = this.container.querySelector("#ai-review-generate");
    if (generateBtn) {
      generateBtn.disabled = true;
      generateBtn.textContent = 'Submitting...';
    }

    try {
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
      const resp = await fetch('/api/citation-pipeline/trigger', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-TOKEN': csrfToken,
        },
        credentials: 'include',
        body: JSON.stringify({ book, force: this.container.querySelector('#ai-review-force')?.checked || false }),
      });

      const data = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        throw new Error(data.message || `Request failed: ${resp.status}`);
      }

      this._pipelineId = data.pipeline_id;
      this.setAiReviewState('reviewing');
      this.startAiReviewPolling();
    } catch (error) {
      console.error('AI Review trigger failed:', error);
      alert('Failed to start AI Citation Review: ' + error.message);
      if (generateBtn) {
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate Review';
      }
    }
  }

  async loadAiReviewStatus() {
    const section = this.container.querySelector('#ai-review-section');
    const aiBtn = this.container.querySelector('#ai-review-btn');
    if (!section || !aiBtn || aiBtn.disabled) return; // not premium or no section

    try {
      // 1. Check if a completed AIreview sub-book already exists
      const aiReviewBook = `${book}/AIreview`;
      let aiReviewExists = false;

      // Try IndexedDB first (fast)
      try {
        const db = await openDatabase();
        const libRecord = await getRecord(db, "library", aiReviewBook);
        if (libRecord) aiReviewExists = true;
      } catch (_) { /* ignore IndexedDB errors */ }

      // If not in IndexedDB, check backend
      if (!aiReviewExists) {
        try {
          const libResp = await fetch(`/api/database-to-indexeddb/books/${encodeURIComponent(aiReviewBook)}/library`, {
            credentials: 'include',
          });
          if (libResp.ok) {
            const libData = await libResp.json();
            if (libData.success && libData.library) aiReviewExists = true;
          }
        } catch (_) { /* ignore fetch errors */ }
      }

      // 2. Check if a pipeline is currently running
      const resp = await fetch(`/api/citation-pipeline/running/${encodeURIComponent(book)}`, {
        credentials: 'include',
      });
      if (!resp.ok) {
        if (aiReviewExists) this.setAiReviewState('completed');
        return;
      }
      const data = await resp.json();

      if (data.pipeline) {
        this._pipelineId = data.pipeline.id;
        this.setAiReviewState('reviewing', data.pipeline.current_step);
        this.startAiReviewPolling();
        return;
      }

      // No running pipeline — show completed if AIreview sub-book exists
      if (aiReviewExists) {
        this.setAiReviewState('completed');
        return;
      }
    } catch (err) {
      console.warn('Failed to load AI review status:', err);
    }
  }

  setAiReviewState(state, currentStep) {
    const aiBtn = this.container.querySelector('#ai-review-btn');
    if (!aiBtn) return;

    const stepLabels = {
      bibliography: 'Scanning bibliography',
      content: 'Scanning citations',
      vacuum: 'Fetching sources',
      ocr: 'Processing PDFs',
      review: 'Reviewing citations',
    };

    const infoPanel = this.container.querySelector('#ai-review-info');

    if (state === 'reviewing') {
      const stepText = (currentStep && stepLabels[currentStep]) || 'Reviewing...';
      aiBtn.disabled = true;
      aiBtn.style.color = '#4EACAE';
      aiBtn.style.borderColor = 'rgba(78,172,174,0.4)';
      aiBtn.style.cursor = 'not-allowed';
      aiBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        ${stepText}`;
      if (infoPanel) infoPanel.style.display = 'none';
    } else if (state === 'completed') {
      aiBtn.disabled = false;
      aiBtn.style.color = '#4EACAE';
      aiBtn.style.borderColor = 'rgba(78,172,174,0.4)';
      aiBtn.style.cursor = 'pointer';
      aiBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        See Review`;
      if (infoPanel) infoPanel.style.display = 'none';

      // Replace click handler to navigate to review page
      const newBtn = aiBtn.cloneNode(true);
      aiBtn.parentNode.replaceChild(newBtn, aiBtn);
      newBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = `/${encodeURIComponent(book)}/AIreview`;
      });

      // Add "Regenerate" link below
      const existingRegen = this.container.querySelector('#ai-review-regenerate');
      if (!existingRegen) {
        const regenLink = document.createElement('a');
        regenLink.id = 'ai-review-regenerate';
        regenLink.href = '#';
        regenLink.textContent = 'Regenerate';
        regenLink.style.cssText = 'display: block; font-size: 11px; color: #888; margin-top: 6px; text-decoration: underline; cursor: pointer;';
        regenLink.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          // Reset to idle state so user can trigger a new scan
          const btn = this.container.querySelector('#ai-review-btn');
          if (btn) {
            const freshBtn = btn.cloneNode(false);
            freshBtn.style.color = '#EF8D34';
            freshBtn.style.borderColor = 'rgba(239,141,52,0.4)';
            freshBtn.style.cursor = 'pointer';
            freshBtn.disabled = false;
            freshBtn.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              AI Citation Review`;
            btn.parentNode.replaceChild(freshBtn, btn);
            freshBtn.addEventListener('click', (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const panel = this.container.querySelector('#ai-review-info');
              if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            });
          }
          regenLink.remove();
        });
        newBtn.parentNode.insertBefore(regenLink, newBtn.nextSibling);
      }
    }
  }

  startAiReviewPolling() {
    this.stopAiReviewPolling(); // clear any existing interval
    this._aiReviewPollInterval = setInterval(() => {
      this.pollAiReviewStatus();
    }, 30000);
  }

  stopAiReviewPolling() {
    if (this._aiReviewPollInterval) {
      clearInterval(this._aiReviewPollInterval);
      this._aiReviewPollInterval = null;
    }
  }

  async pollAiReviewStatus() {
    try {
      if (!this._pipelineId) return;

      const resp = await fetch(`/api/citation-pipeline/status/${encodeURIComponent(this._pipelineId)}`, {
        credentials: 'include',
      });
      if (!resp.ok) return;
      const data = await resp.json();
      const pipeline = data.pipeline;
      if (!pipeline) return;

      if (pipeline.status === 'completed') {
        this.stopAiReviewPolling();
        this.setAiReviewState('completed');
      } else if (pipeline.status === 'failed') {
        this.stopAiReviewPolling();
        // Reset button to idle state
        const aiBtn = this.container.querySelector('#ai-review-btn');
        if (aiBtn) {
          aiBtn.disabled = false;
          aiBtn.style.color = '#EF8D34';
          aiBtn.style.borderColor = 'rgba(239,141,52,0.4)';
          aiBtn.style.cursor = 'pointer';
          aiBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            AI Citation Review`;
        }
      } else {
        // Still running — update the step display
        this.setAiReviewState('reviewing', pipeline.current_step);
      }
    } catch (err) {
      console.warn('AI review poll failed:', err);
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
      this.attachInternalListeners();
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

    // Re-attach all internal listeners (download, edit, privacy toggle)
    this.attachInternalListeners();
  }
}

// This instance is created only ONCE.
const sourceManager = new SourceContainerManager(
  "source-container",
  "source-overlay",
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

let _TurndownGfm = null;
async function loadTurndownGfm() {
  if (_TurndownGfm) return _TurndownGfm;
  const mod = await import('https://cdn.skypack.dev/turndown-plugin-gfm');
  _TurndownGfm = mod;
  return _TurndownGfm;
}

let _JSZip = null;
async function loadJSZip() {
  if (_JSZip) return _JSZip;
  const mod = await import('https://cdn.skypack.dev/jszip');
  _JSZip = mod.default;
  return _JSZip;
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
 * Converts citation HTML (from formatBibtexToCitation) to inline markdown.
 * <i>text</i> → *text*, <a href="url">text</a> → [text](url), strips other tags.
 */
function citationHtmlToMarkdown(html) {
  return html
    .replace(/<i>([^<]*)<\/i>/g, '*$1*')
    .replace(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/g, '[$2]($1)')
    .replace(/<[^>]+>/g, '');
}

/**
 * Fetches all nodes for a book, converts to markdown,
 * and returns { markdown, images }.
 */
async function buildMarkdownForBook(bookId = book || 'latest') {
  const chunks = await getNodeChunksFromIndexedDB(bookId);
  chunks.sort((a, b) => a.chunk_id - b.chunk_id);

  const parser = new DOMParser();

  // --- Phase 1: Parse all chunks into DOM fragments ---
  const fragments = [];
  for (const chunk of chunks) {
    const frag = parser.parseFromString(
      `<div>${chunk.content || chunk.html}</div>`,
      'text/html'
    ).body.firstChild;
    fragments.push(frag);
  }

  // --- Phase 2: Pre-scan for footnote refs, hypercite arrows, citation refs, images ---
  const footnoteRefIds = [];
  const hyperciteArrows = [];
  const citationRefIds = [];
  const imageUrls = new Set();
  const seenFnIds = new Set();

  for (const frag of fragments) {
    frag.querySelectorAll('sup.footnote-ref[id]').forEach(sup => {
      if (!seenFnIds.has(sup.id)) {
        seenFnIds.add(sup.id);
        footnoteRefIds.push(sup.id);
      }
    });

    frag.querySelectorAll('a.citation-ref[id]').forEach(cite => {
      citationRefIds.push(cite.id);
    });

    frag.querySelectorAll('a[href]').forEach(anchor => {
      if (anchor.querySelector('sup.open-icon') && anchor.id && !seenFnIds.has(anchor.id)) {
        seenFnIds.add(anchor.id);
        try {
          const href = anchor.getAttribute('href');
          const parsed = new URL(href, window.location.origin);
          const segments = parsed.pathname.split('/').filter(Boolean);
          if (segments.length > 0) {
            let sourceUrl = parsed.origin + parsed.pathname;
            if (parsed.hash) {
              sourceUrl += parsed.hash;
            }
            hyperciteArrows.push({ id: anchor.id, targetBookId: decodeURIComponent(segments[0]), sourceUrl });
          }
        } catch (e) {
          console.warn('Failed to parse hypercite href:', anchor.getAttribute('href'), e);
        }
      }
    });

    frag.querySelectorAll('img[src]').forEach(img => {
      imageUrls.add(img.getAttribute('src'));
    });
  }

  // --- Phase 3: Fetch footnote content from IndexedDB ---
  const footnoteContents = new Map(); // fnId → markdown string
  let fnDb;
  if (footnoteRefIds.length > 0) {
    try { fnDb = await openDatabase(); } catch (e) { console.warn('Failed to open DB for footnotes:', e); }
  }

  // Helper: convert footnote HTML nodes to markdown text
  const Turndown = await loadTurndown();
  const simpleTd = new Turndown({ headingStyle: 'atx' });

  for (const fnId of footnoteRefIds) {
    const subBookId = `${bookId}/${fnId}`;
    try {
      let fnNodes = await getNodeChunksFromIndexedDB(subBookId);

      if ((!fnNodes || fnNodes.length === 0) && fnDb) {
        try {
          const tx = fnDb.transaction('footnotes', 'readonly');
          const index = tx.objectStore('footnotes').index('footnoteId');
          const results = await new Promise((resolve, reject) => {
            const req = index.getAll(fnId);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
          });
          const fnRecord = results.find(r => r.book === bookId);
          if (fnRecord?.preview_nodes?.length) {
            fnNodes = fnRecord.preview_nodes;
          }
        } catch (e) {
          console.warn(`Failed to look up footnotes store for ${fnId}:`, e);
        }
      }

      if (fnNodes) fnNodes.sort((a, b) => a.chunk_id - b.chunk_id);
      const paragraphs = [];
      for (const node of (fnNodes || [])) {
        const content = node.content || node.html || '';
        if (content.trim()) {
          paragraphs.push(simpleTd.turndown(content).trim());
        }
      }
      footnoteContents.set(fnId, paragraphs.length > 0 ? paragraphs : ['(footnote)']);
    } catch (e) {
      console.warn(`Failed to fetch footnote content for ${fnId}:`, e);
      footnoteContents.set(fnId, ['(footnote)']);
    }
  }

  // --- Phase 4: Fetch citation data for hypercite arrows ---
  const hyperciteContents = new Map(); // elementId → markdown citation string
  let db;
  if (hyperciteArrows.length > 0) {
    try { db = await openDatabase(); } catch (e) { console.warn('Failed to open database for hypercite citations:', e); }
  }

  for (const { id, targetBookId, sourceUrl } of hyperciteArrows) {
    let citationMd = targetBookId;
    try {
      if (db) {
        const record = await getRecord(db, 'library', targetBookId);
        if (record?.bibtex) {
          let citationHtml = await formatBibtexToCitation(record.bibtex);
          if (sourceUrl) {
            if (citationHtml.includes('<a ')) {
              citationHtml = citationHtml.replace(/(<a\s[^>]*href=")([^"]*)(")/, `$1${sourceUrl}$3`);
            } else {
              const titleMatch = citationHtml.match(/(<i>[^<]+<\/i>|"[^"]+")/);
              if (titleMatch) {
                citationHtml = citationHtml.replace(titleMatch[0], `<a href="${sourceUrl}">${titleMatch[0]}</a>`);
              } else {
                citationHtml = `<a href="${sourceUrl}">${citationHtml}</a>`;
              }
            }
          }
          citationMd = citationHtmlToMarkdown(citationHtml);
        }
      }
    } catch (e) {
      console.warn(`Failed to fetch citation for ${targetBookId}:`, e);
    }
    hyperciteContents.set(id, citationMd);
  }

  // --- Phase 4b: Fetch bibliography records for citation refs ---
  const referencesData = [];
  if (citationRefIds.length > 0) {
    let bibDb;
    try { bibDb = db || fnDb || await openDatabase(); } catch (e) { console.warn('Failed to open DB for bibliography:', e); }
    if (bibDb) {
      const seenSourceIds = new Set();
      for (const refId of citationRefIds) {
        try {
          const tx = bibDb.transaction('bibliography', 'readonly');
          const store = tx.objectStore('bibliography');
          const record = await new Promise((resolve, reject) => {
            const req = store.get([bookId, refId]);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          if (record?.content && !seenSourceIds.has(record.source_id)) {
            seenSourceIds.add(record.source_id);
            referencesData.push({ content: record.content });
          }
        } catch (e) {
          console.warn(`Failed to fetch bibliography record for ${refId}:`, e);
        }
      }
    }
  }

  // --- Phase 5: Configure Turndown with GFM tables and custom rules ---
  const turndownService = new Turndown({ headingStyle: 'atx' });

  // Apply GFM tables plugin
  try {
    const gfm = await loadTurndownGfm();
    if (gfm.tables) {
      turndownService.use(gfm.tables);
    }
  } catch (e) {
    console.warn('Failed to load GFM tables plugin:', e);
  }

  // Track hypercite counter for footnote labels
  let hyperciteCounter = 0;
  const hyperciteLabels = new Map(); // elementId → "hyperciteN"

  // Custom rule: footnote references
  turndownService.addRule('footnote-ref', {
    filter: (node) => {
      return node.nodeName === 'SUP'
        && node.classList?.contains('footnote-ref')
        && node.id
        && footnoteContents.has(node.id);
    },
    replacement: (content, node) => `[^${node.id}]`
  });

  // Custom rule: hypercite arrows
  turndownService.addRule('hypercite-arrow', {
    filter: (node) => {
      return node.nodeName === 'A'
        && node.querySelector?.('sup.open-icon')
        && node.id
        && hyperciteContents.has(node.id);
    },
    replacement: (content, node) => {
      if (!hyperciteLabels.has(node.id)) {
        hyperciteCounter++;
        hyperciteLabels.set(node.id, `hypercite${hyperciteCounter}`);
      }
      return `[^${hyperciteLabels.get(node.id)}]`;
    }
  });

  // Custom rule: citation refs → plain text
  turndownService.addRule('citation-ref', {
    filter: (node) => {
      return node.nodeName === 'A' && node.classList?.contains('citation-ref');
    },
    replacement: (content) => content
  });

  // Image filename tracking for deduplication
  const imageFilenames = new Map(); // src → filename
  const usedFilenames = new Set();

  function getImageFilename(src) {
    if (imageFilenames.has(src)) return imageFilenames.get(src);
    let filename;
    try {
      const urlPath = new URL(src, window.location.origin).pathname;
      filename = urlPath.split('/').pop() || 'image.png';
    } catch {
      filename = 'image.png';
    }
    // Deduplicate
    let base = filename;
    let counter = 1;
    while (usedFilenames.has(filename)) {
      const dot = base.lastIndexOf('.');
      if (dot > 0) {
        filename = `${base.substring(0, dot)}-${counter}${base.substring(dot)}`;
      } else {
        filename = `${base}-${counter}`;
      }
      counter++;
    }
    usedFilenames.add(filename);
    imageFilenames.set(src, filename);
    return filename;
  }

  // Custom rule: image rewrite
  turndownService.addRule('image-rewrite', {
    filter: 'img',
    replacement: (content, node) => {
      const src = node.getAttribute('src');
      if (!src) return '';
      const alt = node.getAttribute('alt') || '';
      const filename = getImageFilename(src);
      return `![${alt}](images/${filename})`;
    }
  });

  // --- Phase 6: Convert each chunk through Turndown ---
  const mdParts = [];
  for (const frag of fragments) {
    const html = frag.innerHTML;
    if (html.trim()) {
      mdParts.push(turndownService.turndown(html));
    }
  }

  // --- Phase 7: Build footnotes section ---
  const footnoteDefs = [];

  // Regular footnotes
  for (const fnId of footnoteRefIds) {
    const paragraphs = footnoteContents.get(fnId) || ['(footnote)'];
    const first = paragraphs[0];
    const rest = paragraphs.slice(1);
    let def = `[^${fnId}]: ${first}`;
    for (const p of rest) {
      def += `\n\n    ${p.split('\n').join('\n    ')}`;
    }
    footnoteDefs.push(def);
  }

  // Hypercite footnotes
  for (const [elementId, label] of hyperciteLabels) {
    const citation = hyperciteContents.get(elementId) || elementId;
    footnoteDefs.push(`[^${label}]: ${citation}`);
  }

  // --- Phase 8: Build references section ---
  let referencesMd = '';
  if (referencesData.length > 0) {
    const refLines = ['## References', ''];
    for (const ref of referencesData) {
      const refMd = citationHtmlToMarkdown(ref.content);
      refLines.push(refMd);
      refLines.push('');
    }
    referencesMd = refLines.join('\n');
  }

  // --- Phase 9: Join body + footnotes + references ---
  const sections = [mdParts.join('\n\n')];
  if (footnoteDefs.length > 0) {
    sections.push('---\n\n' + footnoteDefs.join('\n\n'));
  }
  if (referencesMd) {
    sections.push('---\n\n' + referencesMd);
  }
  const markdown = sections.join('\n\n');

  // Collect image sources for bundling
  const images = imageUrls.size > 0
    ? Array.from(imageUrls).map(src => ({ src, filename: getImageFilename(src) }))
    : [];

  return { markdown, images };
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
    const { markdown, images } = await buildMarkdownForBook(bookId);

    if (images.length > 0) {
      // Bundle as zip with images
      const JSZip = await loadJSZip();
      const zip = new JSZip();
      zip.file(`book-${bookId}.md`, markdown);

      const imgFolder = zip.folder('images');
      for (const { src, filename } of images) {
        try {
          const resp = await fetch(src);
          const blob = await resp.blob();
          imgFolder.file(filename, blob);
        } catch (e) {
          console.warn('Failed to fetch image for zip:', src, e);
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `book-${bookId}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      console.log(`✅ Markdown + images exported as book-${bookId}.zip`);
    } else {
      const filename = `book-${bookId}.md`;
      downloadMarkdown(filename, markdown);
      console.log(`✅ Markdown exported to ${filename}`);
    }
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
function htmlElementToDocx(node, docxComponents, opts = {}) {
  const { TextRun, Paragraph, HeadingLevel, ExternalHyperlink, FootnoteReferenceRun, footnoteMap, Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun } = docxComponents;
  const out = [];

  node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      // plain text
      const runOpts = { text: child.textContent, font: "Helvetica" };
      if (opts.bold) runOpts.bold = true;
      if (opts.italics) runOpts.italics = true;
      if (opts.superScript) runOpts.superScript = true;
      if (opts.subScript) runOpts.subScript = true;
      out.push(new TextRun(runOpts));
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
          const headingRuns = htmlElementToDocx(child, docxComponents, opts);
          out.push(
            new Paragraph({
              children: headingRuns,
              heading: level,
            })
          );
          break;
        }

        case 'strong':
        case 'b': {
          htmlElementToDocx(child, docxComponents, { ...opts, bold: true }).forEach(item => out.push(item));
          break;
        }

        case 'em':
        case 'i': {
          htmlElementToDocx(child, docxComponents, { ...opts, italics: true }).forEach(item => out.push(item));
          break;
        }

        case 'sup': {
          // Footnote reference → Word footnote
          if (child.classList?.contains('footnote-ref') && child.id && footnoteMap?.has(child.id)) {
            out.push(new FootnoteReferenceRun(footnoteMap.get(child.id)));
            break;
          }
          // Hypercite open icon → skip (handled by parent <a>)
          if (child.classList?.contains('open-icon')) {
            break;
          }
          // Regular superscript
          htmlElementToDocx(child, docxComponents, { ...opts, superScript: true }).forEach(item => out.push(item));
          break;
        }

        case 'sub': {
          htmlElementToDocx(child, docxComponents, { ...opts, subScript: true }).forEach(item => out.push(item));
          break;
        }

        case 'a': {
          // Hypercite arrow link → Word footnote
          if (child.querySelector?.('sup.open-icon') && child.id && footnoteMap?.has(child.id)) {
            out.push(new FootnoteReferenceRun(footnoteMap.get(child.id)));
            break;
          }
          // Citation ref (no href) → plain text
          if (child.classList?.contains('citation-ref')) {
            out.push(new TextRun({ text: child.textContent, font: "Helvetica" }));
            break;
          }
          // Regular external hyperlink
          const url = child.getAttribute('href') || '';
          const text = child.textContent;
          out.push(
            new ExternalHyperlink({
              link: url,
              children: [
                new TextRun({
                  text,
                  font: "Helvetica",
                  style: 'Hyperlink',
                }),
              ],
            })
          );
          break;
        }

        case 'br': {
          out.push(new TextRun({ text: '\n', font: "Helvetica" }));
          break;
        }

        case 'p': {
          const pChildren = htmlElementToDocx(child, docxComponents, opts);
          out.push(new Paragraph({ children: pChildren, style: "Normal" }));
          break;
        }

        case 'blockquote': {
          const inner = htmlElementToDocx(child, docxComponents, { ...opts, italics: true });
          let bqBuf = [];
          const flush = () => {
            if (bqBuf.length) {
              out.push(new Paragraph({
                children: bqBuf,
                indent: { left: 720 },
                style: "Normal",
              }));
              bqBuf = [];
            }
          };
          inner.forEach(item => {
            if (item instanceof Paragraph) {
              flush();
              // Push the nested paragraph as-is (it already has its own content)
              out.push(item);
            } else {
              bqBuf.push(item);
            }
          });
          flush();
          break;
        }

        case 'ul':
        case 'ol': {
          const isOrdered = tag === 'ol';
          const ref = isOrdered ? 'numbered-list' : 'bullet-list';
          const level = opts.listLevel || 0;
          const instance = docxComponents.nextListInstance++;

          child.childNodes.forEach(li => {
            if (li.nodeType !== Node.ELEMENT_NODE) return;
            if (li.tagName.toLowerCase() !== 'li') return;

            // Separate inline content from nested lists
            const tempDiv = document.createElement('div');
            const nestedLists = [];
            li.childNodes.forEach(liChild => {
              const liTag = liChild.nodeType === Node.ELEMENT_NODE && liChild.tagName.toLowerCase();
              if (liTag === 'ul' || liTag === 'ol') {
                nestedLists.push(liChild);
              } else {
                tempDiv.appendChild(liChild.cloneNode(true));
              }
            });

            const liRuns = htmlElementToDocx(tempDiv, docxComponents, opts);
            const runs = liRuns.filter(item => !(item instanceof Paragraph));
            const paras = liRuns.filter(item => item instanceof Paragraph);

            // Main list item paragraph with Word numbering
            if (runs.length) {
              out.push(new Paragraph({
                children: runs,
                numbering: { reference: ref, level, instance },
              }));
            }
            paras.forEach(p => out.push(p));

            // Nested lists at deeper level — wrap in a container so the walker hits the <ul>/<ol> tag
            for (const nested of nestedLists) {
              const wrapper = document.createElement('div');
              wrapper.appendChild(nested.cloneNode(true));
              htmlElementToDocx(wrapper, docxComponents, { ...opts, listLevel: level + 1 })
                .forEach(item => out.push(item));
            }
          });
          break;
        }

        case 'pre': {
          const codeEl = child.querySelector('code');
          const text = codeEl ? codeEl.textContent : child.textContent;
          const lines = text.split('\n');
          lines.forEach(line => {
            out.push(new Paragraph({
              children: [
                new TextRun({
                  text: line || ' ',
                  font: "Courier New",
                }),
              ],
              spacing: { after: 0, line: 240 },
            }));
          });
          break;
        }

        case 'code': {
          // Inline code
          const codeOpts = { text: child.textContent, font: "Courier New" };
          if (opts.bold) codeOpts.bold = true;
          if (opts.italics) codeOpts.italics = true;
          out.push(new TextRun(codeOpts));
          break;
        }

        case 'table': {
          if (!Table) break;
          const rows = [];
          const trElements = child.querySelectorAll('tr');
          // Count max columns from first row to distribute width evenly
          const firstTr = trElements[0];
          const colCount = firstTr ? firstTr.querySelectorAll('th, td').length : 1;
          // Use DXA (twips) for reliable cross-platform rendering
          // Standard page: 8.5" with 1" margins = 6.5" content = 9360 twips
          const totalTableWidth = 9360;
          const cellWidthDxa = Math.floor(totalTableWidth / colCount);
          const columnWidths = Array(colCount).fill(cellWidthDxa);

          trElements.forEach(tr => {
            const cells = [];
            tr.querySelectorAll('th, td').forEach(cell => {
              const isTh = cell.tagName.toLowerCase() === 'th';
              const cellItems = htmlElementToDocx(cell, docxComponents, isTh ? { ...opts, bold: true } : opts);
              // Group runs into paragraphs
              const cellParas = [];
              let cellBuf = [];
              cellItems.forEach(item => {
                if (item instanceof Paragraph) {
                  if (cellBuf.length) {
                    cellParas.push(new Paragraph({ children: cellBuf }));
                    cellBuf = [];
                  }
                  cellParas.push(item);
                } else {
                  cellBuf.push(item);
                }
              });
              if (cellBuf.length) cellParas.push(new Paragraph({ children: cellBuf }));
              if (cellParas.length === 0) cellParas.push(new Paragraph({ children: [] }));

              cells.push(new TableCell({
                children: cellParas,
                width: { size: cellWidthDxa, type: WidthType.DXA },
              }));
            });
            if (cells.length > 0) {
              rows.push(new TableRow({ children: cells }));
            }
          });
          if (rows.length > 0) {
            out.push(new Table({
              rows,
              columnWidths,
              width: { size: totalTableWidth, type: WidthType.DXA },
            }));
          }
          break;
        }

        case 'img': {
          if (!ImageRun) break;
          const src = child.getAttribute('src');
          if (src) {
            const rawW = child.getAttribute('width');
            const rawH = child.getAttribute('height');
            const imgWidth = parseInt(rawW, 10) || 400;
            const imgHeight = parseInt(rawH, 10) || 300;
            out.push({ __imagePlaceholder: true, src, width: imgWidth, height: imgHeight, hasWidth: !!rawW, hasHeight: !!rawH });
          }
          break;
        }

        default:
          // everything else: recurse inline
          htmlElementToDocx(child, docxComponents, opts).forEach(item => out.push(item));
      }
    }
  });

  return out;
}

// Build the docx with styled runs/headings/links
async function buildDocxWithStyles(bookId = book || 'latest') {
  const docxLib = await loadDocxLib();
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, FootnoteReferenceRun, Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun, LevelFormat, AlignmentType } = docxLib;
  const chunks = await getNodeChunksFromIndexedDB(bookId);
  chunks.sort((a,b) => a.chunk_id - b.chunk_id);

  const parser = new DOMParser();

  // --- Phase 1: Parse all chunks into DOM fragments ---
  const fragments = [];
  for (const chunk of chunks) {
    const frag = parser.parseFromString(
      `<div>${chunk.content||chunk.html}</div>`,
      'text/html'
    ).body.firstChild;
    fragments.push(frag);
  }

  // --- Phase 2: Pre-scan fragments for footnote refs and hypercite arrows ---
  const footnoteMap = new Map();       // elementId → footnoteNumber
  const footnoteDefinitions = {};      // { number: { children: [Paragraph, ...] } }
  let fnCounter = 1;

  // Collect footnote ref IDs
  const footnoteRefIds = [];
  // Collect hypercite arrow elements: { id, targetBookId }
  const hyperciteArrows = [];
  // Collect citation ref IDs for References section
  const citationRefIds = [];

  for (const frag of fragments) {
    // Footnote refs: <sup class="footnote-ref" id="Fn...">
    frag.querySelectorAll('sup.footnote-ref[id]').forEach(sup => {
      if (!footnoteMap.has(sup.id)) {
        footnoteRefIds.push(sup.id);
      }
    });

    // Citation refs: <a class="citation-ref" id="Ref...">
    frag.querySelectorAll('a.citation-ref[id]').forEach(cite => {
      citationRefIds.push(cite.id);
    });

    // Hypercite arrows: <a href="..."><sup class="open-icon">↗</sup></a>
    frag.querySelectorAll('a[href]').forEach(anchor => {
      if (anchor.querySelector('sup.open-icon') && anchor.id && !footnoteMap.has(anchor.id)) {
        try {
          const href = anchor.getAttribute('href');
          const urlPath = new URL(href, window.location.origin).pathname;
          // Extract book ID from first path segment (decoded)
          const segments = urlPath.split('/').filter(Boolean);
          if (segments.length > 0) {
            const parsed = new URL(href, window.location.origin);
            // Use ?scroll= instead of # — Word encodes # to %23 in external hyperlinks
            let sourceUrl = parsed.origin + parsed.pathname;
            if (parsed.hash) {
              sourceUrl += '?scroll=' + encodeURIComponent(parsed.hash.substring(1));
            }
            hyperciteArrows.push({ id: anchor.id, targetBookId: decodeURIComponent(segments[0]), sourceUrl });
          }
        } catch (e) {
          console.warn('Failed to parse hypercite href:', anchor.getAttribute('href'), e);
        }
      }
    });
  }

  // Helper: convert HTML content to docx paragraphs (for footnote bodies)
  const htmlToFootnoteParagraphs = (htmlContent) => {
    const fnFrag = parser.parseFromString(
      `<div>${htmlContent}</div>`,
      'text/html'
    ).body.firstChild;
    // Use a simple docxComponents without footnoteMap to avoid recursion
    const fnDocxComponents = { TextRun, Paragraph, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun, nextListInstance: 0 };
    const items = htmlElementToDocx(fnFrag, fnDocxComponents);
    // Group runs into paragraphs
    const paragraphs = [];
    let runBuf = [];
    items.forEach(item => {
      if (item instanceof Paragraph) {
        if (runBuf.length) {
          paragraphs.push(new Paragraph({ children: runBuf }));
          runBuf = [];
        }
        paragraphs.push(item);
      } else {
        runBuf.push(item);
      }
    });
    if (runBuf.length) {
      paragraphs.push(new Paragraph({ children: runBuf }));
    }
    return paragraphs;
  };

  // --- Phase 3: Fetch footnote content from IndexedDB ---
  // Open DB once for footnote fallback lookups
  let fnDb;
  if (footnoteRefIds.length > 0) {
    try { fnDb = await openDatabase(); } catch (e) { console.warn('Failed to open DB for footnotes:', e); }
  }

  for (const fnId of footnoteRefIds) {
    const subBookId = `${bookId}/${fnId}`;
    try {
      // Try nodes store first (works if footnote was previously opened)
      let fnNodes = await getNodeChunksFromIndexedDB(subBookId);

      // Fallback: check footnotes store for preview_nodes
      if ((!fnNodes || fnNodes.length === 0) && fnDb) {
        try {
          const tx = fnDb.transaction('footnotes', 'readonly');
          const index = tx.objectStore('footnotes').index('footnoteId');
          const results = await new Promise((resolve, reject) => {
            const req = index.getAll(fnId);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
          });
          // Find the record matching our parent book
          const fnRecord = results.find(r => r.book === bookId);
          if (fnRecord?.preview_nodes?.length) {
            fnNodes = fnRecord.preview_nodes;
          }
        } catch (e) {
          console.warn(`Failed to look up footnotes store for ${fnId}:`, e);
        }
      }

      if (fnNodes) fnNodes.sort((a, b) => a.chunk_id - b.chunk_id);
      let fnParagraphs = [];
      for (const node of (fnNodes || [])) {
        const content = node.content || node.html || '';
        fnParagraphs.push(...htmlToFootnoteParagraphs(content));
      }
      if (fnParagraphs.length === 0) {
        fnParagraphs = [new Paragraph({ children: [new TextRun({ text: '(footnote)', font: 'Helvetica' })] })];
      }
      const num = fnCounter++;
      footnoteMap.set(fnId, num);
      footnoteDefinitions[num] = { children: fnParagraphs };
    } catch (e) {
      console.warn(`Failed to fetch footnote content for ${fnId}:`, e);
      const num = fnCounter++;
      footnoteMap.set(fnId, num);
      footnoteDefinitions[num] = { children: [new Paragraph({ children: [new TextRun({ text: '(footnote)', font: 'Helvetica' })] })] };
    }
  }

  // --- Phase 4: Fetch citation data for hypercite arrows ---
  let db;
  if (hyperciteArrows.length > 0) {
    try {
      db = await openDatabase();
    } catch (e) {
      console.warn('Failed to open database for hypercite citations:', e);
    }
  }

  for (const { id, targetBookId, sourceUrl } of hyperciteArrows) {
    let fnParagraphs = [];
    try {
      if (db) {
        const record = await getRecord(db, 'library', targetBookId);
        if (record?.bibtex) {
          let citationHtml = await formatBibtexToCitation(record.bibtex);
          if (sourceUrl) {
            if (citationHtml.includes('<a ')) {
              // Replace existing link URL with sourceUrl
              citationHtml = citationHtml.replace(/(<a\s[^>]*href=")([^"]*)(")/, `$1${sourceUrl}$3`);
            } else {
              // No link in citation — wrap just the title (italic or quoted text) in a link
              // Match <i>Title</i> or "Title"
              const titleMatch = citationHtml.match(/(<i>[^<]+<\/i>|"[^"]+")/) ;
              if (titleMatch) {
                citationHtml = citationHtml.replace(titleMatch[0], `<a href="${sourceUrl}">${titleMatch[0]}</a>`);
              } else {
                // Fallback: wrap the whole thing
                citationHtml = `<a href="${sourceUrl}">${citationHtml}</a>`;
              }
            }
          }
          fnParagraphs = htmlToFootnoteParagraphs(citationHtml);
        }
      }
    } catch (e) {
      console.warn(`Failed to fetch citation for ${targetBookId}:`, e);
    }
    if (fnParagraphs.length === 0) {
      // Fallback: create a linked citation with the target book ID
      const linkChildren = sourceUrl
        ? [new ExternalHyperlink({
            link: sourceUrl,
            children: [new TextRun({ text: targetBookId, font: "Helvetica", style: 'Hyperlink' })],
          })]
        : [new TextRun({ text: targetBookId, font: 'Helvetica' })];
      fnParagraphs = [new Paragraph({ children: linkChildren })];
    }
    const num = fnCounter++;
    footnoteMap.set(id, num);
    footnoteDefinitions[num] = { children: fnParagraphs };
  }

  // --- Phase 4b: Fetch citation content from bibliography store for References section ---
  const referencesData = [];
  if (citationRefIds.length > 0) {
    let bibDb;
    try { bibDb = db || fnDb || await openDatabase(); } catch (e) { console.warn('Failed to open DB for bibliography:', e); }
    if (bibDb) {
      const seenSourceIds = new Set();
      for (const refId of citationRefIds) {
        try {
          const tx = bibDb.transaction('bibliography', 'readonly');
          const store = tx.objectStore('bibliography');
          const record = await new Promise((resolve, reject) => {
            const req = store.get([bookId, refId]);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          if (record?.content && !seenSourceIds.has(record.source_id)) {
            seenSourceIds.add(record.source_id);
            referencesData.push({ content: record.content });
          }
        } catch (e) {
          console.warn(`Failed to fetch bibliography record for ${refId}:`, e);
        }
      }
    }
  }

  // --- Phase 5: Convert fragments to docx elements ---
  const docxComponents = { TextRun, Paragraph, HeadingLevel, ExternalHyperlink, FootnoteReferenceRun, footnoteMap, Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun, nextListInstance: 0 };
  const children = [];

  // Debug: count element types for diagnostics
  const tagCounts = {};

  for (const frag of fragments) {
    // Log what top-level tag is inside each fragment's wrapper div
    frag.childNodes.forEach(child => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    });

    const runsAndParas = htmlElementToDocx(frag, docxComponents);

    // group Runs into Paragraphs; Tables and image placeholders are block-level
    let buf = [];
    runsAndParas.forEach(item => {
      const isBlock = (item instanceof Paragraph) || (item instanceof Table) || item?.__imagePlaceholder;
      if (isBlock) {
        if (buf.length) {
          children.push(new Paragraph({ children: buf, style: "Normal" }));
          buf = [];
        }
        children.push(item);
      } else {
        buf.push(item);
      }
    });
    if (buf.length) {
      children.push(new Paragraph({ children: buf, style: "Normal" }));
    }
  }

  console.log('📊 DOCX export tag summary:', tagCounts);

  // --- Phase 6: Append References section ---
  if (referencesData.length > 0) {
    children.push(new Paragraph({
      children: [new TextRun({ text: 'References', font: 'Helvetica' })],
      heading: HeadingLevel.HEADING_2,
      pageBreakBefore: true,
    }));
    for (const ref of referencesData) {
      const refFrag = parser.parseFromString(
        `<div>${ref.content}</div>`,
        'text/html'
      ).body.firstChild;
      const refDocxComponents = { TextRun, Paragraph, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun, nextListInstance: 0 };
      const refItems = htmlElementToDocx(refFrag, refDocxComponents);
      let refBuf = [];
      refItems.forEach(item => {
        const isBlock = (item instanceof Paragraph) || (item instanceof Table) || item?.__imagePlaceholder;
        if (isBlock) {
          if (refBuf.length) {
            children.push(new Paragraph({ children: refBuf, style: "Normal" }));
            refBuf = [];
          }
          children.push(item);
        } else {
          refBuf.push(item);
        }
      });
      if (refBuf.length) {
        children.push(new Paragraph({ children: refBuf, style: "Normal" }));
      }
    }
  }

  // --- Phase 7: Resolve image placeholders ---
  for (let i = 0; i < children.length; i++) {
    const item = children[i];
    if (item?.__imagePlaceholder) {
      try {
        const resp = await fetch(item.src);
        const blob = await resp.blob();
        const buf = await blob.arrayBuffer();

        // Resolve natural dimensions from the image itself
        let w = item.width;
        let h = item.height;
        const hasExplicitSize = item.hasWidth && item.hasHeight;
        if (!hasExplicitSize) {
          try {
            const bmp = await createImageBitmap(blob);
            w = bmp.width;
            h = bmp.height;
            bmp.close();
          } catch (_) { /* keep defaults */ }
        }

        // Cap to fit page content width (~600px)
        if (w > 600) {
          const scale = 600 / w;
          w = Math.round(600);
          h = Math.round(h * scale);
        }
        children[i] = new Paragraph({
          children: [new ImageRun({
            data: buf,
            transformation: { width: w, height: h },
          })],
        });
      } catch (e) {
        console.warn('Failed to fetch image for docx export:', item.src, e);
        children[i] = new Paragraph({
          children: [new TextRun({ text: `[image: ${item.src}]`, font: 'Helvetica', italics: true })],
          style: 'Normal',
        });
      }
    }
  }

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'bullet-list',
          levels: [
            { level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } }, run: { font: 'Symbol' } } },
            { level: 1, format: LevelFormat.BULLET, text: '\u25CB', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1440, hanging: 360 } }, run: { font: 'Courier New' } } },
            { level: 2, format: LevelFormat.BULLET, text: '\u25AA', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 2160, hanging: 360 } }, run: { font: 'Symbol' } } },
          ],
        },
        {
          reference: 'numbered-list',
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
            { level: 1, format: LevelFormat.LOWER_LETTER, text: '%2.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
            { level: 2, format: LevelFormat.LOWER_ROMAN, text: '%3.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 2160, hanging: 360 } } } },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: { font: "Helvetica", size: 22 },
          paragraph: { spacing: { after: 200, line: 276 } },
        },
        heading1: {
          run: { font: "Helvetica", size: 48, bold: true },
          paragraph: { spacing: { before: 360, after: 120 } },
        },
        heading2: {
          run: { font: "Helvetica", size: 36, bold: true },
          paragraph: { spacing: { before: 280, after: 100 } },
        },
        heading3: {
          run: { font: "Helvetica", size: 28, bold: true },
          paragraph: { spacing: { before: 240, after: 80 } },
        },
        heading4: {
          run: { font: "Helvetica", size: 24, bold: true },
          paragraph: { spacing: { before: 200, after: 80 } },
        },
        heading5: {
          run: { font: "Helvetica", size: 22, bold: true },
        },
        heading6: {
          run: { font: "Helvetica", size: 22, bold: true, italics: true },
        },
      },
      paragraphStyles: [
        {
          id: "Normal",
          name: "Normal",
          run: { font: "Helvetica", size: 22 },
          paragraph: { spacing: { after: 200, line: 276 } },
        },
      ],
    },
    footnotes: footnoteDefinitions,
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
  if (sourceManager) {
    // Close container if open and reset animation state
    sourceManager.stopAiReviewPolling();
    if (sourceManager.isOpen && sourceManager.container) {
      sourceManager.container.classList.add("hidden");
      sourceManager.container.classList.remove("open");
      sourceManager.isOpen = false;
      sourceManager.isInEditMode = false;
      window.activeContainer = "main-content";
    }
    sourceManager.isAnimating = false;

    // Remove cloudRef click handler
    if (sourceManager.button && sourceClickHandler) {
      sourceManager.button.removeEventListener("click", sourceClickHandler);
      sourceClickHandler = null;
    }
    if (sourceManager.button) {
      delete sourceManager.button.dataset.sourceListenerAttached;
    }
  }
}
// Builds the inner-HTML for the source container: citation + license, the
// Downloads section, the AI Citation Review section, Creator Tools toggle, the
// privacy/edit buttons, and the (hidden) edit-library-card form. Pure HTML
// string builder — listeners are wired by sourceContainer/index.ts after this
// HTML is injected. Kept in its own leaf so editForm/index can both import it
// without a static import cycle.
import { openDatabase } from '../../indexedDB/index';
import { formatBibtexToCitation } from '../../utilities/bibtexProcessor';
import { book } from '../../app';
import { canUserEditBook, getAuthContextSync } from '../../utilities/auth/index';
import { getRecord, isSyntheticBook, PUBLIC_SVG, PRIVATE_SVG } from './helpers';
import { sourceStatusSectionHtml } from './checkSource';
import type { LibraryRecord } from '../../indexedDB/types';

/**
 * Build the inner-HTML for the source container:
 *  - fetch bibtex from IndexedDB
 *  - format it to a citation
 *  - append a Download section with two buttons
 */
export async function buildSourceHtml(currentBookId: any): Promise<string> {
  const db = await openDatabase();
  let record: LibraryRecord | null = await getRecord(db, "library", book);

  // If not in IndexedDB, try fetching from server (skip synthetic books that have no real row)
  let accessDenied = false;
  if (!record && !isSyntheticBook(book)) {
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
    const year = new Date(record.timestamp ?? Date.now()).getFullYear();
    const url = record.url || record.oa_url || record.pdf_url || record.doi;
    const urlField = url ? `  url = {${url}},\n` : '';
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
        <path d="M12 20h9" stroke="var(--icon-stroke-primary)" />
        <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" stroke="var(--icon-stroke-primary)" />
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
  const LICENSE_INFO: any = {
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
    licenseHtml = `<p class="license-line" style="font-size: 12px; color: var(--color-label); margin-top: 10px;">📄 <a href="${licenseInfo.url}" target="_blank" style="color: var(--color-label); text-decoration: underline;">${licenseInfo.short}</a></p>`;
  } else if (license === 'custom' && record?.custom_license_text) {
    const escapedText = record.custom_license_text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    licenseHtml = `<p class="license-line" style="font-size: 12px; color: var(--color-label); margin-top: 10px; cursor: help;" title="${escapedText}">📄 ${licenseInfo.short}</p>`;
  } else {
    licenseHtml = `<p class="license-line" style="font-size: 12px; color: var(--color-label); margin-top: 10px;">📄 ${licenseInfo.short}</p>`;
  }

  return `
    <div class="resize-edge resize-left" title="Resize width"></div>
    <div class="scroller" id="source-content">
    <p class="citation" style="padding-bottom: 5px">${citation}</p>
    ${licenseHtml}
    ${sourceStatusSectionHtml(record, canEdit, accessDenied)}

    <div style="margin-top: 15px; padding-top: 15px;">
      <h3>Download</h3>

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

    <button type="button" id="download-epub" class="download-btn">
  <div class="icon-wrapper">
    <svg
      class="download-icon"
      xmlns="http://www.w3.org/2000/svg"
      shape-rendering="geometricPrecision"
      text-rendering="geometricPrecision"
      image-rendering="optimizeQuality"
      fill-rule="evenodd"
      clip-rule="evenodd"
      viewBox="0 0 480 511.462"
    >
      <path fill="currentColor" d="M105.662 237.133h270.139v-81.852h-86.024c-9.016 0-21.614-4.888-27.56-10.835-5.948-5.948-9.594-16.683-9.594-25.7V31.619H33.922c-1.335 0-2.494 1.123-2.494 2.494v443.236c0 1.285 1.159 2.494 2.494 2.494h339.385c.7 0 2.494-1.887 2.494-2.494v-46.466H105.662c-17.256 0-31.464-14.159-31.464-31.465v-130.82c0-17.306 14.157-31.465 31.464-31.465zm47.235 114.854v4.58c2.618.262 5.235.393 7.851.393 8.114 0 16.315-1.309 24.601-3.926l3.141 19.236c-9.77 2.617-19.454 3.926-29.049 3.926-12.214 0-21.047-2.858-26.5-8.572-5.451-5.714-8.178-14.416-8.178-26.106 0-11.69 2.727-20.392 8.178-26.106 5.453-5.714 14.264-8.571 26.433-8.571 12.171 0 20.567 1.658 25.191 4.972 4.624 3.316 6.935 9.51 6.935 18.583 0 7.677-2.77 13.195-8.309 16.553-5.54 3.359-15.637 5.038-30.294 5.038zm0-20.545v5.366h5.366c3.14 0 5.43-.327 6.869-.981 1.44-.655 2.16-2.16 2.16-4.515v-5.366h-5.366c-3.141 0-5.43.327-6.869.982-1.44.654-2.16 2.159-2.16 4.514zm92.582 23.031h-17.011v19.76h-26.172v-81.786h41.22c18.756 0 28.135 10.076 28.135 30.228 0 11.079-2.443 19.28-7.328 24.601-1.832 2.006-4.362 3.708-7.59 5.103-3.228 1.397-6.979 2.094-11.254 2.094zm-17.011-41.089v20.152h6.02c3.14 0 5.431-.327 6.869-.981 1.44-.654 2.159-2.159 2.159-4.515v-9.16c0-2.355-.719-3.86-2.159-4.515-1.438-.654-3.729-.981-6.869-.981h-6.02zm76.226-20.937v61.372h9.29c3.315 0 5.584-.414 6.804-1.243 1.222-.829 1.833-2.726 1.833-5.692v-54.437h26.171v45.93c0 7.416-.48 13.392-1.44 17.928-.959 4.537-2.747 8.376-5.364 11.516-2.617 3.14-6.194 5.321-10.73 6.543-4.537 1.221-10.426 1.832-17.666 1.832-7.241 0-13.107-.611-17.601-1.832-4.492-1.222-8.047-3.403-10.665-6.543-2.617-3.14-4.405-6.979-5.364-11.516-.96-4.536-1.44-10.512-1.44-17.928v-45.93h26.172zm56.202 81.786v-81.786h42.398c7.852 0 13.457 1.527 16.816 4.58 3.358 3.053 5.038 7.503 5.038 13.348 0 5.844-1.069 10.359-3.206 13.544-2.138 3.183-4.995 5.256-8.571 6.215v.785c10.555 1.832 15.833 9.029 15.833 21.591 0 6.543-1.744 11.8-5.234 15.769-3.489 3.97-8.855 5.954-16.095 5.954h-46.979zm36.379-32.584h-10.206v13.348h10.076c3.664 0 5.495-2.225 5.495-6.674s-1.788-6.674-5.365-6.674zm-1.963-31.274h-8.243v12.17h8.113c3.314 0 4.971-2.029 4.971-6.086s-1.613-6.084-4.841-6.084zm11.869-73.242h41.354c17.307 0 31.465 14.205 31.465 31.465v130.82c0 17.26-14.204 31.465-31.465 31.465h-41.354v56.407c0 13.325-10.849 24.172-24.174 24.172H24.173C10.848 511.462 0 500.614 0 487.29V24.173C0 10.864 10.873 0 24.173 0h244.492c3.477.035 8.353 1.44 10.359 3.454l124.895 126.429c2.11 2.11 3.646 4.988 3.646 8.249 0 .96-.193 1.727-.384 2.687v96.314zM281.135 116.261V37.027l89.211 90.362h-78.083c-3.07 0-5.755-1.343-7.867-3.262-1.918-1.918-3.261-4.796-3.261-7.866z"/>
    </svg>
    </div>
  </button>

    ${canEdit ? `<button type="button" id="download-all" class="download-btn">
  <div class="icon-wrapper">
    <svg
      class="download-icon"
      viewBox="0 0 24 24"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
      style="width: 80%; height: 100%;"
    >
      <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" fill="currentColor"/>
      <text x="12" y="16" text-anchor="middle" font-size="7" font-weight="bold" fill="var(--color-background)" font-family="sans-serif">raw</text>
    </svg>
    </div>
  </button>` : ''}
    </div>

    ${canEdit ? (() => {
      const authCtx = getAuthContextSync();
      const isLoggedIn = authCtx?.isLoggedIn;
      const isPremium = authCtx?.user?.status === 'premium';

      let btnHtml = '';
      if (!isLoggedIn) {
        btnHtml = `
          <button type="button" id="ai-review-btn" disabled style="width: 100%; padding: 8px 12px; font-size: 13px; color: var(--color-label); border: 1px solid rgba(136,136,136,0.4); background: transparent; border-radius: 4px; cursor: not-allowed; display: flex; align-items: center; justify-content: center; gap: 6px; opacity: 0.6;">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg>
            AI Citation Review
          </button>
          <p style="font-size: 11px; color: var(--color-text-faint); margin-top: 6px;">Must be logged in.</p>`;
      } else {
        btnHtml = `
          <button type="button" id="ai-review-btn" style="width: 100%; padding: 8px 12px; font-size: 13px; color: var(--hyperlit-orange); border: 1px solid rgba(239,141,52,0.4); background: transparent; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg>
            AI Citation Review
          </button>
          <div id="ai-review-info" style="display: none; margin-top: 10px;">
            <p style="font-size: 12px; color: var(--color-text-secondary); margin: 0 0 10px 0; line-height: 1.5;">AI Citation Review compares all citations in this text to open databases, pulling any available data. It then compares the truth claim of each citation to the source material. The review takes 10-15 minutes. You will be emailed on completion.</p>
            <p style="font-size: 12px; color: var(--color-text-secondary); margin: 0 0 10px 0;">${isPremium
              ? 'Cost: <strong>Included with Premium</strong>'
              : `Estimated cost: <strong>around $1.00</strong> <span style="opacity:0.7">(varies by book length)</span> <span class="ai-review-cost-info-toggle" tabindex="0" role="button" aria-label="Pricing info" style="cursor:pointer;display:inline-block;width:15px;height:15px;line-height:15px;text-align:center;border-radius:50%;border:1px solid rgba(239,141,52,0.5);font-size:10px;vertical-align:middle;margin-left:4px;">?</span><span class="ai-review-cost-info-detail" style="display:none;"> AI Citation Review uses OCR and multiple LLMs to verify each citation. Cost depends on the number of citations and source length. For no markup, <a href="https://github.com/toldandretold/hyperlit" target="_blank" style="color:inherit;text-decoration:underline;">clone Hyperlit from GitHub</a> (it's free software) and use your own API keys.</span>`
            }</p>
            <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-text-secondary); margin-bottom: 10px; cursor: pointer;">
              <input type="checkbox" id="ai-review-force" style="accent-color: var(--hyperlit-orange);" />
              Rescan all sources from scratch
            </label>
            <button type="button" id="ai-review-generate" style="width: 100%; padding: 8px 12px; font-size: 13px; color: #221F20; background: var(--hyperlit-orange); border: none; border-radius: 4px; cursor: pointer; font-family: inherit;">Generate Review</button>
          </div>`;
      }

      return `<div id="ai-review-section" data-lib-timestamp="${record?.timestamp || 0}" style="margin-top: 15px; padding-top: 15px;">
        <h3>AI Citation Review</h3>
        ${btnHtml}
      </div>`;
    })() : ''}

    ${(canEdit && !accessDenied) ? `
    <div id="creator-tools-section" style="margin-top: 15px; padding-top: 15px;">
      <button type="button" id="creator-tools-toggle">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
        </svg>
        Creator Tools
        <svg class="creator-tools-chevron" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <div id="creator-tools-content" style="display: none;"></div>
    </div>` : ''}

    </div>

    ${privacyToggleHtml}
    ${editButtonHtml}

    <!-- Edit Form (initially hidden) -->
    <div id="edit-form-container" class="hidden" style="display: none;">
      <div class="scroller">
        <form id="edit-source-form">
          <div class="form-header">
            <h2 style="color: var(--hyperlit-orange);">Edit Library Card</h2>
            <p class="form-subtitle">Update the citation details for this book</p>
          </div>

          <!-- BibTeX Section -->
          <div class="form-section">
            <label for="edit-bibtex">BibTeX</label>
            <textarea id="edit-bibtex" name="bibtex" placeholder="Paste or drop a .bib file here..."></textarea>
          </div>

          <!-- Type Selection -->
          <div class="form-section">
            <label>Type:</label>
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

        </form>
      </div>
      <div class="mask-top"></div>
      <div class="mask-bottom"></div>
    </div>
  `;
}

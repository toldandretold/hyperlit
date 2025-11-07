/**
 * Hyperlight Content Builder
 * Constructs HTML content for displaying highlights in the hyperlit container
 */

import { openDatabase } from '../../indexedDB.js';
import { getCurrentUserId } from '../../auth.js';

/**
 * Build highlight content section
 * @param {Object} contentType - The highlight content type object
 * @param {Array} newHighlightIds - Array of new highlight IDs
 * @param {IDBDatabase} db - Reused database connection
 * @returns {Promise<string>} HTML string for highlight content
 */
export async function buildHighlightContent(contentType, newHighlightIds = [], db = null) {
  try {
    const { highlightIds } = contentType;
    console.log(`🎨 Building highlight content for IDs:`, highlightIds);

    const currentUserId = await getCurrentUserId();
    console.log(`👤 Current user ID:`, currentUserId);

    const database = db || await openDatabase();
    const tx = database.transaction("hyperlights", "readonly");
    const store = tx.objectStore("hyperlights");
    const idx = store.index("hyperlight_id");

    // Fetch all highlights in parallel
    const reads = highlightIds.map((id) =>
      new Promise((res, rej) => {
        const req = idx.get(id);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      })
    );

    const results = await Promise.all(reads);
    console.log(`📊 Highlight DB results:`, results);

    const validResults = results.filter((r) => r);
    console.log(`✅ Valid highlight results:`, validResults);

    if (validResults.length === 0) {
      console.warn("⚠️ No valid highlight results found");
      return `
        <div class="highlights-section">
          <div class="error">No highlight data found</div>
          <hr>
        </div>`;
    }


    // Check if current user can edit any of the books these highlights belong to
    const { canUserEditBook } = await import('../../auth.js');
    const bookPermissions = new Map();

    // Get unique book IDs and check permissions
    const uniqueBooks = [...new Set(validResults.map(h => h.book))];
    for (const bookId of uniqueBooks) {
      const canEdit = await canUserEditBook(bookId);
      bookPermissions.set(bookId, canEdit);
    }

    // Import formatRelativeTime from utils
    const { formatRelativeTime } = await import('../utils.js');

    let html = `<div class="highlights-section">
<br>
<h1>Hyperlights</h1>
<br>
`;
    let firstUserAnnotation = null;

    validResults.forEach((h, index) => {
      const isUserHighlight = h.creator ? h.creator === currentUserId : (!h.creator && h.creator_token === currentUserId);
      const isNewlyCreated = newHighlightIds.includes(h.hyperlight_id);
      const isEditable = isUserHighlight || isNewlyCreated;
      const authorName = h.creator || "Anon";
      const relativeTime = formatRelativeTime(h.time_since);
      const truncatedText = h.highlightedText.length > 140 ? h.highlightedText.substring(0, 140) + '...' : h.highlightedText;

      html += `  <div class="author" id="${h.hyperlight_id}">
`;
      html += `    <div style="display: flex; justify-content: space-between; align-items: center;">
`;
      html += `      <div><b>${authorName}</b><i class="time">・${relativeTime}</i></div>
`;

      // Add delete button if user has permission
      if (isUserHighlight) {
        // User's own highlight - full delete
        html += `      <button class="delete-highlight-btn" data-highlight-id="${h.hyperlight_id}" data-action="delete" title="Delete your highlight (hidden for everyone)" type="button">
`;
        html += `        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
`;
        html += `          <path d="M3 6h18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
`;
        html += `          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
`;
        html += `        </svg>
`;
        html += `      </button>
`;
      } else {
        // Other's highlight - check if current user can edit this book (same logic as editButton.js)
        const canEditThisBook = bookPermissions.get(h.book);

        if (canEditThisBook) {
          // User can edit this book - show hide button for others' highlights
          html += `      <button class="delete-highlight-btn" data-highlight-id="${h.hyperlight_id}" data-action="hide" title="Delete highlight (will be hidden for everyone)" type="button">
`;
          html += `        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
`;
          html += `          <path d="M3 6h18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
`;
        html += `          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
`;
        html += `        </svg>
`;
        html += `      </button>
`;
        }
      }

      html += `    </div>
`;

      html += `  </div>
`;
      html += `  <blockquote class="highlight-text" contenteditable="${isEditable}" `;
      html += `data-highlight-id="${h.hyperlight_id}" data-content-id="${h.hyperlight_id}">
`;
      html += `    "${truncatedText}"
`;
      html += `  </blockquote>
`;
      html += `  <div class="annotation" contenteditable="${isEditable}" `;
      html += `data-highlight-id="${h.hyperlight_id}" data-content-id="${h.hyperlight_id}">
`;
      html += `    ${h.annotation || ""}
`;
      html += `  </div>
`;
      html += `  <br>
`;

      // Add hr between highlights (but not after the last one)
      if (index < validResults.length - 1) {
        html += `  <hr style="margin: 1em 0;">
`;
      }

      // Track first user annotation for cursor placement
      if (isEditable && !firstUserAnnotation) {
        firstUserAnnotation = h.hyperlight_id;
      }
    });

    html += `<hr style="margin: 1em 0;">
</div>
`;

    // Store first user annotation for post-open actions
    if (firstUserAnnotation) {
      html = html.replace('<div class="highlights-section">',
        `<div class="highlights-section" data-first-user-annotation="${firstUserAnnotation}">`);
    }

    return html;
  } catch (error) {
    console.error('Error building highlight content:', error);
    return `
      <div class="highlights-section">
        <div class="error">No highlight data found</div>
        <hr>
      </div>`;
  }
}

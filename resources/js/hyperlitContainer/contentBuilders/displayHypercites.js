/**
 * Hypercite Content Builder
 * Constructs HTML content for displaying hypercites in the hyperlit container
 * Includes citation management functions (health checks, deletion)
 */

import { book } from '../../app.js';
import { openDatabase } from '../../indexedDB/index.js';
import { formatBibtexToCitation } from "../../utilities/bibtexProcessor.js";
import { canUserEditBook } from "../../utilities/auth.js";
import DOMPurify from 'dompurify';

/**
 * Validate URL to prevent javascript: and other dangerous protocols
 * @param {string} url - The URL to validate
 * @returns {string} Safe URL or '#' if dangerous
 */
function sanitizeUrl(url) {
  if (!url) return '#';
  try {
    // Handle relative URLs by using current origin as base
    const parsed = new URL(url, window.location.origin);
    // Only allow http, https protocols
    if (['http:', 'https:'].includes(parsed.protocol)) {
      return url;
    }
    // For relative URLs starting with /, allow them
    if (url.startsWith('/') && !url.startsWith('//')) {
      return url;
    }
    console.warn(`Blocked dangerous URL protocol: ${parsed.protocol}`);
    return '#';
  } catch {
    // If URL parsing fails, check if it's a simple relative path
    if (url.startsWith('/') && !url.toLowerCase().includes('javascript:')) {
      return url;
    }
    return '#';
  }
}

/**
 * Extract the footnoteId or hyperlightId from a citation URL path
 * @param {string} urlPart - The URL path (before the hash fragment)
 * @param {boolean} isFootnoteURL - Whether this is a footnote URL
 * @param {boolean} isHyperlightURL - Whether this is a hyperlight URL
 * @returns {string|null} The content item ID (footnoteId or hyperlightId)
 */
function extractContentIdFromUrl(urlPart, isFootnoteURL, isHyperlightURL) {
  const pathParts = urlPart.split("/").filter(p => p);

  if (isHyperlightURL) {
    // Format: /bookId/HL_xxx → hyperlightId = "HL_xxx"
    const hlPart = pathParts.find(p => p.startsWith("HL_"));
    return hlPart || null;
  }

  if (isFootnoteURL) {
    // New format: /bookId/FnTimestamp_random → footnoteId = "FnTimestamp_random"
    const fnPart = pathParts.find(p => /^Fn\d/.test(p));
    if (fnPart) return fnPart;

    // Old format: /bookId_FnN (single segment) → footnoteId = "bookId_FnN"
    const fnSegment = pathParts.find(p => p.includes("_Fn"));
    return fnSegment || null;
  }

  return null;
}

/**
 * Build hypercite content section
 * @param {Object} contentType - The hypercite content type object
 * @param {IDBDatabase} db - Reused database connection
 * @returns {Promise<string>} HTML string for hypercite content
 */
export async function buildHyperciteContent(contentType, db = null) {
  try {
    const { hyperciteId, hyperciteIds, relationshipStatus, cachedData } = contentType;
    // Use the original clicked hyperciteId as the data-content-id for all links
    const originalHyperciteId = hyperciteId || (hyperciteIds && hyperciteIds[0]) || 'unknown';
    console.log(`🔗 Building hypercite content for ID: ${hyperciteId}, IDs: ${JSON.stringify(hyperciteIds)}, status: ${relationshipStatus}`);

    if (relationshipStatus === 'single') {
      console.log(`📝 Single hypercite - returning simple content`);
      return `
        <div class="hypercites-section">
          <b>Hypercite</b>
          <div class="hypercite-single">This is a single hypercite (not cited elsewhere)</div>
          <hr>
        </div>`;
    }

    const database = db || await openDatabase();
    const hyperciteDataArray = [];

    // 🚀 PERFORMANCE: Use cached data if available (from detectHypercites)
    if (cachedData) {
      console.log(`⚡ Using cached hypercite data - skipping query`);
      hyperciteDataArray.push(cachedData);
    } else {
      // Fetch data for all hypercite IDs
      const tx = database.transaction("hypercites", "readonly");
      const store = tx.objectStore("hypercites");
      const index = store.index("hyperciteId");

      // Use the hyperciteIds array if available, otherwise fall back to single hyperciteId
      const idsToProcess = hyperciteIds || [hyperciteId];

      for (const id of idsToProcess) {
        const getRequest = index.get(id);
        const hyperciteData = await new Promise((resolve, reject) => {
          getRequest.onsuccess = () => resolve(getRequest.result);
          getRequest.onerror = () => reject(getRequest.error);
        });

        if (hyperciteData) {
          hyperciteDataArray.push(hyperciteData);
        }
      }
    }

    if (hyperciteDataArray.length === 0) {
      return `
        <div class="hypercites-section">
          <b>Hypercite</b>
          <div class="error">Hypercite data not found</div>
          <hr>
        </div>`;
    }

    let html = `<div class="hypercites-section">
<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1em;">
  <h1 style="margin: 0;">Cited By</h1>
  <svg class="manage-citations-btn" width="18" height="18" viewBox="0 0 48 48" fill="currentColor" style="cursor: pointer;" title="Manage citations">
    <path d="M12 10C13.1046 10 14 9.10457 14 8C14 6.89543 13.1046 6 12 6C11.2597 6 10.6134 6.4022 10.2676 7H10C8.34315 7 7 8.34315 7 10V19C6.44774 19 5.99531 19.4487 6.04543 19.9987C6.27792 22.5499 7.39568 24.952 9.22186 26.7782C10.561 28.1173 12.2098 29.0755 14 29.583V32C14 33.3064 14.835 34.4177 16.0004 34.8294C16.043 38.7969 19.2725 42 23.25 42C27.2541 42 30.5 38.7541 30.5 34.75V30.75C30.5 28.6789 32.1789 27 34.25 27C36.3211 27 38 28.6789 38 30.75V33.1707C36.8348 33.5825 36 34.6938 36 36C36 37.6569 37.3431 39 39 39C40.6569 39 42 37.6569 42 36C42 34.6938 41.1652 33.5825 40 33.1707V30.75C40 27.5744 37.4256 25 34.25 25C31.0744 25 28.5 27.5744 28.5 30.75V34.75C28.5 37.6495 26.1495 40 23.25 40C20.3769 40 18.0429 37.6921 18.0006 34.8291C19.1655 34.4171 20 33.306 20 32V29.583C21.7902 29.0755 23.4391 28.1173 24.7782 26.7782C26.6044 24.952 27.7221 22.5499 27.9546 19.9987C28.0048 19.4487 27.5523 19 27 19L27 10C27 8.34315 25.6569 7 24 7H23.7324C23.3866 6.4022 22.7403 6 22 6C20.8954 6 20 6.89543 20 8C20 9.10457 20.8954 10 22 10C22.7403 10 23.3866 9.5978 23.7324 9H24C24.5523 9 25 9.44772 25 10V19H25.2095C24.6572 19 24.2166 19.4499 24.1403 19.9969C23.9248 21.5406 23.2127 22.983 22.0979 24.0979C20.7458 25.4499 18.9121 26.2095 17 26.2095C15.088 26.2095 13.2542 25.4499 11.9022 24.0979C10.7873 22.983 10.0753 21.5406 9.8598 19.9969C9.78344 19.4499 9.34286 19 8.79057 19L9 19V10C9 9.44772 9.44772 9 10 9H10.2676C10.6134 9.5978 11.2597 10 12 10Z"/>
  </svg>
</div>
`;

    // Collect all citedIN links with their corresponding hypercite IDs
    const citedINLinksWithIds = [];
    for (const hyperciteData of hyperciteDataArray) {
      if (Array.isArray(hyperciteData.citedIN) && hyperciteData.citedIN.length > 0) {
        hyperciteData.citedIN.forEach(link => {
          citedINLinksWithIds.push({
            link: link,
            hyperciteId: hyperciteData.hyperciteId
          });
        });
      }
    }

    // Remove duplicates based on link URL (but keep the hyperciteId association)
    const uniqueCitedINLinks = citedINLinksWithIds.filter((item, index, self) =>
      index === self.findIndex(t => t.link === item.link)
    );

    if (uniqueCitedINLinks.length > 0) {
      // 🚀 PERFORMANCE: Extract all bookIDs first
      const citationMetadata = uniqueCitedINLinks.map(citationItem => {
        const { link: citationID, hyperciteId } = citationItem;
        const citationParts = citationID.split("#");
        const urlPart = citationParts[0];
        const isHyperlightURL = urlPart.includes("/HL_");
        const isFootnoteURL = urlPart.includes("_Fn") || /\/Fn\d/.test(urlPart);

        let bookID;
        if (isHyperlightURL) {
          const pathParts = urlPart.split("/");
          for (let i = 0; i < pathParts.length; i++) {
            if (pathParts[i].startsWith("HL_") && i > 0) {
              bookID = pathParts[i-1];
              break;
            }
          }
          if (!bookID) {
            bookID = pathParts.filter(part => part && !part.startsWith("HL_"))[0] || "";
          }
        } else if (isFootnoteURL) {
          // Old format: "/bookId_Fn..." or "/book/bookId_Fn..."
          const fnMatch = urlPart.match(/\/([^\/]+)_Fn/);
          if (fnMatch) {
            bookID = fnMatch[1];
          } else {
            // New format: "/bookId/FnTimestamp_random" (Fn as separate path segment)
            const pathParts = urlPart.split("/").filter(p => p);
            const fnIndex = pathParts.findIndex(p => /^Fn\d/.test(p));
            if (fnIndex > 0) {
              bookID = pathParts[fnIndex - 1];
            } else {
              bookID = urlPart.replace("/", "").split("_Fn")[0];
            }
          }
        } else {
          bookID = urlPart.replace("/", "");
        }

        const hasHyperciteInUrl = citationParts.length > 1;
        const hyperciteIdFromUrl = hasHyperciteInUrl ? citationParts[1] : null;

        // Extract content item ID for footnote/hyperlight health checks
        let contentType = 'node';
        let contentItemId = '';
        if (isFootnoteURL) {
          contentType = 'footnote';
          contentItemId = extractContentIdFromUrl(urlPart, true, false) || '';
        } else if (isHyperlightURL) {
          contentType = 'hyperlight';
          contentItemId = extractContentIdFromUrl(urlPart, false, true) || '';
        }

        return {
          citationID,
          hyperciteId,
          bookID,
          isHyperlightURL,
          isFootnoteURL,
          hasHyperciteInUrl,
          hyperciteIdFromUrl,
          contentType,
          contentItemId
        };
      });

      // 🚀 PERFORMANCE: Batch all library queries at once
      const uniqueBookIDs = [...new Set(citationMetadata.map(m => m.bookID))];
      console.log(`⚡ Batch fetching ${uniqueBookIDs.length} library records instead of ${citationMetadata.length} sequential queries`);

      const libraryTx = database.transaction("library", "readonly");
      const libraryStore = libraryTx.objectStore("library");
      const libraryDataMap = new Map();

      await Promise.all(uniqueBookIDs.map(bookID =>
        new Promise((resolve) => {
          const req = libraryStore.get(bookID);
          req.onsuccess = () => {
            libraryDataMap.set(bookID, req.result);
            resolve();
          };
          req.onerror = () => {
            libraryDataMap.set(bookID, null);
            resolve();
          };
        })
      ));

      // Import fetchLibraryFromServer from utils
      const { fetchLibraryFromServer } = await import('../utils.js');

      // 🚀 PERFORMANCE: Process all citations with cached library data
      const linksHTML = await Promise.all(
        citationMetadata.map(async (meta) => {
          const { citationID, hyperciteId, bookID, isHyperlightURL, isFootnoteURL, hasHyperciteInUrl, hyperciteIdFromUrl, contentType, contentItemId } = meta;

          // 🚀 PERFORMANCE: Skip permission check during initial render (deferred to post-render)
          // Add placeholder for management buttons that will be injected asynchronously
          let managementButtonsHtml = '';
          if (hasHyperciteInUrl) {
            // Use hyperciteId (the actual owner of this citedIN link) not originalHyperciteId (the clicked hypercite)
            // This matters for overlapping hypercites where citations from different sources are displayed together
            managementButtonsHtml = `
      <span class="hypercite-management-buttons" data-book-id="${bookID}" data-citation-url="${citationID}" data-hypercite-id="${hyperciteIdFromUrl}" data-source-hypercite-id="${hyperciteId}" data-content-type="${contentType}" data-content-item-id="${contentItemId}">
        <!-- Buttons will be injected after permission check -->
      </span>
    `;
          }

          // Get library data from cached map
          let libraryData = libraryDataMap.get(bookID);

          // Fallback to server if not in IndexedDB
          if (!libraryData || !libraryData.bibtex) {
            libraryData = await fetchLibraryFromServer(bookID);
          }

          if (libraryData && libraryData.bibtex) {
            const rawFormattedCitation = await formatBibtexToCitation(libraryData.bibtex);
            // Sanitize citation to prevent XSS from malicious bibtex data
            const formattedCitation = DOMPurify.sanitize(rawFormattedCitation, { ALLOWED_TAGS: ['i', 'em', 'b', 'strong'] });

            // Check if the book is private and add lock icon
            const isPrivate = libraryData.visibility === 'private';
            const lockIcon = isPrivate
              ? '<svg class="private-lock-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d73a49" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: text-bottom; margin-left: -20px; margin-right: 4px; transition: transform 0.2s ease;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>'
              : '';

            const citationText = isHyperlightURL
              ? `${lockIcon}a <span id="citedInHyperlight">Hyperlight</span> in ${formattedCitation}`
              : isFootnoteURL
              ? `${lockIcon}a <span id="citedInFootnote">Footnote</span> in ${formattedCitation}`
              : `${lockIcon}${formattedCitation}`;

            // Add data attributes for private books to enable deferred auth checking
            const privateAttrs = isPrivate
              ? `data-private="true" data-book-id="${bookID}"`
              : '';

            // Sanitize URL to prevent javascript: protocol XSS
            const safeHref = sanitizeUrl(citationID);
            return `<blockquote>${citationText} <a href="${safeHref}" class="citation-link" data-content-id="${hyperciteId}" ${privateAttrs}><span class="open-icon">↗</span></a>${managementButtonsHtml}</blockquote>`;
          } else {
            // Sanitize URL to prevent javascript: protocol XSS
            const safeHref = sanitizeUrl(citationID);
            const displayUrl = DOMPurify.sanitize(citationID, { ALLOWED_TAGS: [] });
            return `<a href="${safeHref}" class="citation-link" data-content-id="${hyperciteId}">${displayUrl}${managementButtonsHtml}</a>`;
          }
        })
      );

      html += `<div class="citation-links">
${linksHTML.join("")}
</div>
`;
    } else {
      html += `<p>No citations available.</p>
`;
    }

    html += `<hr>
</div>
`;

    return html;
  } catch (error) {
    console.error('Error building hypercite content:', error);
    return `
      <div class="hypercites-section">
        <b>Hypercite:</b>
        <div class="error">Error loading hypercite data</div>
        <hr>
      </div>`;
  }
}

/**
 * Check if a hypercite exists in a specific book's nodes
 * Searches for the hypercite ID in the content HTML (pasted citations appear as <a id="hypercite_xxx">)
 * @param {string} bookId - The book to search in
 * @param {string} hyperciteId - The hypercite ID to search for (e.g., "hypercite_zlpx0209")
 * @returns {Promise<{exists: boolean, chunkKey: string|null}>}
 */
export async function checkHyperciteExists(bookId, hyperciteId, contentType = 'node', contentItemId = null) {
  try {
    console.log(`🔍 Checking if hypercite ${hyperciteId} exists in book ${bookId} (type=${contentType}, itemId=${contentItemId})`);

    const db = await openDatabase();
    const idPattern = `id="${hyperciteId}"`;

    // --- Footnote check ---
    if (contentType === 'footnote' && contentItemId) {
      // Look up the specific footnote in IndexedDB
      const fnTx = db.transaction('footnotes', 'readonly');
      const fnStore = fnTx.objectStore('footnotes');
      const fnRequest = fnStore.get([bookId, contentItemId]);

      const footnote = await new Promise((resolve, reject) => {
        fnRequest.onsuccess = () => resolve(fnRequest.result);
        fnRequest.onerror = () => reject(fnRequest.error);
      });

      if (footnote && footnote.content && typeof footnote.content === 'string') {
        if (footnote.content.includes(idPattern)) {
          // Secondary check: is this footnote still active in the book?
          // Footnote DB records persist after deletion, so verify the footnoteId
          // is still referenced in at least one node's footnotes array
          const nodesTx = db.transaction('nodes', 'readonly');
          const nodesStore = nodesTx.objectStore('nodes');
          const bookIndex = nodesStore.index('book');
          const nodes = await new Promise((resolve, reject) => {
            const req = bookIndex.getAll(bookId);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
          });

          const footnoteStillActive = nodes.some(node =>
            node.footnotes?.some(fn => {
              const id = typeof fn === 'string' ? fn : fn?.id;
              return id === contentItemId;
            })
          );

          if (!footnoteStillActive) {
            console.log(`⚠️ Hypercite found in footnote content but footnote ${contentItemId} is no longer active in any node`);
            return { exists: false, chunkKey: null };
          }

          console.log(`✅ Found hypercite ${hyperciteId} in active footnote ${contentItemId}`);
          return { exists: true, chunkKey: `${bookId}:footnote:${contentItemId}` };
        }
        console.log(`❌ Hypercite ${hyperciteId} not found in footnote ${contentItemId}`);
        return { exists: false, chunkKey: null };
      }

      // Fallback to PostgreSQL if footnote not in IndexedDB
      console.log(`📡 Footnote not in IndexedDB, checking PostgreSQL for book ${bookId}`);
      try {
        const response = await fetch(`/api/database-to-indexeddb/books/${bookId}/data`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content'),
          },
          credentials: 'include'
        });

        if (response.ok) {
          const data = await response.json();
          const fnData = data.footnotes?.data;
          if (fnData && fnData[contentItemId]) {
            const fnContent = fnData[contentItemId];
            if (typeof fnContent === 'string' && fnContent.includes(idPattern)) {
              // Secondary check: verify footnote is still active in nodes
              const pgNodes = data.nodes || [];
              const fnStillActive = pgNodes.some(node =>
                node.footnotes?.some(fn => {
                  const id = typeof fn === 'string' ? fn : fn?.id;
                  return id === contentItemId;
                })
              );

              if (!fnStillActive) {
                console.log(`⚠️ Hypercite found in PostgreSQL footnote but footnote ${contentItemId} is no longer active`);
                return { exists: false, chunkKey: null };
              }

              console.log(`✅ Found hypercite ${hyperciteId} in active PostgreSQL footnote ${contentItemId}`);
              return { exists: true, chunkKey: `${bookId}:footnote:${contentItemId}` };
            }
          }
        }
      } catch (error) {
        console.error('Error fetching footnote from PostgreSQL:', error);
      }

      console.log(`❌ Hypercite ${hyperciteId} not found in footnote ${contentItemId}`);
      return { exists: false, chunkKey: null };
    }

    // --- Hyperlight check ---
    if (contentType === 'hyperlight' && contentItemId) {
      // Look up the specific hyperlight in IndexedDB
      const hlTx = db.transaction('hyperlights', 'readonly');
      const hlStore = hlTx.objectStore('hyperlights');
      const hlRequest = hlStore.get([bookId, contentItemId]);

      const hyperlight = await new Promise((resolve, reject) => {
        hlRequest.onsuccess = () => resolve(hlRequest.result);
        hlRequest.onerror = () => reject(hlRequest.error);
      });

      if (hyperlight && hyperlight.annotation && typeof hyperlight.annotation === 'string') {
        if (hyperlight.annotation.includes(idPattern)) {
          console.log(`✅ Found hypercite ${hyperciteId} in hyperlight ${contentItemId}`);
          return { exists: true, chunkKey: `${bookId}:hyperlight:${contentItemId}` };
        }
        console.log(`❌ Hypercite ${hyperciteId} not found in hyperlight ${contentItemId}`);
        return { exists: false, chunkKey: null };
      }

      // Fallback to PostgreSQL if hyperlight not in IndexedDB
      console.log(`📡 Hyperlight not in IndexedDB, checking PostgreSQL for book ${bookId}`);
      try {
        const response = await fetch(`/api/database-to-indexeddb/books/${bookId}/data`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content'),
          },
          credentials: 'include'
        });

        if (response.ok) {
          const data = await response.json();
          const hyperlights = data.hyperlights || [];
          const match = hyperlights.find(hl => hl.hyperlight_id === contentItemId);
          if (match && match.annotation && typeof match.annotation === 'string') {
            if (match.annotation.includes(idPattern)) {
              console.log(`✅ Found hypercite ${hyperciteId} in PostgreSQL hyperlight ${contentItemId}`);
              return { exists: true, chunkKey: `${bookId}:hyperlight:${contentItemId}` };
            }
          }
        }
      } catch (error) {
        console.error('Error fetching hyperlight from PostgreSQL:', error);
      }

      console.log(`❌ Hypercite ${hyperciteId} not found in hyperlight ${contentItemId}`);
      return { exists: false, chunkKey: null };
    }

    // --- Node check (default/existing behavior) ---
    const tx = db.transaction(['nodes'], 'readonly');
    const nodesStore = tx.objectStore('nodes');

    // Get all nodes for the book
    const bookIndex = nodesStore.index('book');
    const nodesRequest = bookIndex.getAll(bookId);

    const nodes = await new Promise((resolve, reject) => {
      nodesRequest.onsuccess = () => resolve(nodesRequest.result || []);
      nodesRequest.onerror = () => reject(nodesRequest.error);
    });

    console.log(`📚 Found ${nodes.length} chunks for book ${bookId} in IndexedDB`);

    // Search through all chunks' content for the hypercite ID in HTML
    // Pasted citations appear as: <a href="..." id="hypercite_xxx">
    // Check IndexedDB chunks first
    for (const chunk of nodes) {
      if (chunk.content && typeof chunk.content === 'string') {
        if (chunk.content.includes(idPattern)) {
          const chunkKey = `${bookId}:${chunk.startLine}`;
          console.log(`✅ Found hypercite ${hyperciteId} in IndexedDB chunk ${chunkKey}`);
          return { exists: true, chunkKey };
        }
      }
    }

    // If no chunks in IndexedDB or not found, fall back to PostgreSQL
    if (nodes.length === 0) {
      console.log(`📡 No chunks in IndexedDB, checking PostgreSQL for book ${bookId}`);

      try {
        const response = await fetch(`/api/database-to-indexeddb/books/${bookId}/data`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content'),
          },
          credentials: 'include'
        });

        if (!response.ok) {
          console.warn(`⚠️ Failed to fetch book data from PostgreSQL: ${response.status}`);
          return { exists: false, chunkKey: null };
        }

        const data = await response.json();
        const pgChunks = data.nodes || [];
        console.log(`📚 Found ${pgChunks.length} chunks for book ${bookId} in PostgreSQL`);

        // Search through PostgreSQL chunks
        for (const chunk of pgChunks) {
          if (chunk.content && typeof chunk.content === 'string') {
            if (chunk.content.includes(idPattern)) {
              const chunkKey = `${bookId}:${chunk.startLine}`;
              console.log(`✅ Found hypercite ${hyperciteId} in PostgreSQL chunk ${chunkKey}`);
              return { exists: true, chunkKey };
            }
          }
        }
      } catch (error) {
        console.error('Error fetching from PostgreSQL:', error);
      }
    }

    console.log(`❌ Hypercite ${hyperciteId} not found in book ${bookId}`);
    return { exists: false, chunkKey: null };

  } catch (error) {
    console.error('Error checking hypercite existence:', error);
    return { exists: false, chunkKey: null };
  }
}

/**
 * Handle manage citations button click - injects management buttons after auth check
 * @param {Event} event - The click event
 */
export async function handleManageCitationsClick(event) {
  const svg = event.currentTarget;

  // Show loading state
  svg.style.opacity = '0.5';
  svg.style.pointerEvents = 'none';
  console.log('🔧 Running auth checks and injecting management buttons...');

  const buttonPlaceholders = document.querySelectorAll('.hypercite-management-buttons[data-book-id]');

  // Check permissions for source book (Book A - the one being viewed) AND citing books (Book B)
  // Either creator should be able to delete a broken citation link
  const canEditSource = await canUserEditBook(book);

  const citingBookIds = new Set();
  buttonPlaceholders.forEach(placeholder => {
    const bookId = placeholder.dataset.bookId;
    if (bookId) citingBookIds.add(bookId);
  });

  // Batch permission checks for citing books
  const citingPermissionsMap = new Map();
  await Promise.all(Array.from(citingBookIds).map(async (bookId) => {
    const canEdit = await canUserEditBook(bookId);
    citingPermissionsMap.set(bookId, canEdit);
  }));

  // Inject buttons for all citations (everyone gets health check, source OR citing editors get delete)
  buttonPlaceholders.forEach(placeholder => {
    const bookId = placeholder.dataset.bookId;
    const canEditCiting = citingPermissionsMap.get(bookId);
    const canDelete = canEditSource || canEditCiting;
    const citationUrl = placeholder.dataset.citationUrl;
    const hyperciteId = placeholder.dataset.hyperciteId;
    const sourceHyperciteId = placeholder.dataset.sourceHyperciteId;
    const contentType = placeholder.dataset.contentType || 'node';
    const contentItemId = placeholder.dataset.contentItemId || '';

    // Everyone gets health check button
    let html = `
      <button class="hypercite-health-check-btn"
              data-citing-book="${bookId}"
              data-hypercite-id="${hyperciteId}"
              data-citation-url="${citationUrl}"
              data-content-type="${contentType}"
              data-content-item-id="${contentItemId}"
              title="Check if citation exists"
              type="button">
        <svg width="18" height="18" viewBox="0 0 48 48" fill="currentColor">
          <path d="M12 10C13.1046 10 14 9.10457 14 8C14 6.89543 13.1046 6 12 6C11.2597 6 10.6134 6.4022 10.2676 7H10C8.34315 7 7 8.34315 7 10V19C6.44774 19 5.99531 19.4487 6.04543 19.9987C6.27792 22.5499 7.39568 24.952 9.22186 26.7782C10.561 28.1173 12.2098 29.0755 14 29.583V32C14 33.3064 14.835 34.4177 16.0004 34.8294C16.043 38.7969 19.2725 42 23.25 42C27.2541 42 30.5 38.7541 30.5 34.75V30.75C30.5 28.6789 32.1789 27 34.25 27C36.3211 27 38 28.6789 38 30.75V33.1707C36.8348 33.5825 36 34.6938 36 36C36 37.6569 37.3431 39 39 39C40.6569 39 42 37.6569 42 36C42 34.6938 41.1652 33.5825 40 33.1707V30.75C40 27.5744 37.4256 25 34.25 25C31.0744 25 28.5 27.5744 28.5 30.75V34.75C28.5 37.6495 26.1495 40 23.25 40C20.3769 40 18.0429 37.6921 18.0006 34.8291C19.1655 34.4171 20 33.306 20 32V29.583C21.7902 29.0755 23.4391 28.1173 24.7782 26.7782C26.6044 24.952 27.7221 22.5499 27.9546 19.9987C28.0048 19.4487 27.5523 19 27 19L27 10C27 8.34315 25.6569 7 24 7H23.7324C23.3866 6.4022 22.7403 6 22 6C20.8954 6 20 6.89543 20 8C20 9.10457 20.8954 10 22 10C22.7403 10 23.3866 9.5978 23.7324 9H24C24.5523 9 25 9.44772 25 10V19H25.2095C24.6572 19 24.2166 19.4499 24.1403 19.9969C23.9248 21.5406 23.2127 22.983 22.0979 24.0979C20.7458 25.4499 18.9121 26.2095 17 26.2095C15.088 26.2095 13.2542 25.4499 11.9022 24.0979C10.7873 22.983 10.0753 21.5406 9.8598 19.9969C9.78344 19.4499 9.34286 19 8.79057 19L9 19V10C9 9.44772 9.44772 9 10 9H10.2676C10.6134 9.5978 11.2597 10 12 10Z"/>
        </svg>
      </button>
    `;

    // Source book creator OR citing book creator gets delete button
    if (canDelete) {
      html += `
      <button class="hypercite-delete-btn"
              data-source-book="${book}"
              data-source-hypercite-id="${sourceHyperciteId}"
              data-citation-url="${citationUrl}"
              title="Run health check first"
              type="button"
              disabled>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18" stroke-linecap="round" stroke-linejoin="round"></path>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke-linecap="round" stroke-linejoin="round"></path>
        </svg>
      </button>
      `;
    }

    placeholder.innerHTML = html;
  });

  // Attach listeners to newly injected buttons
  const healthCheckButtons = document.querySelectorAll('.hypercite-health-check-btn');
  healthCheckButtons.forEach(btn => {
    btn.addEventListener('click', handleHyperciteHealthCheck);
  });

  const hyperciteDeleteButtons = document.querySelectorAll('.hypercite-delete-btn');
  hyperciteDeleteButtons.forEach(btn => {
    btn.addEventListener('click', handleHyperciteDelete);
  });

  console.log(`🔗 Injected management buttons for ${citingPermissionsMap.size} citing books (canEditSource=${canEditSource}, ${Array.from(citingPermissionsMap.values()).filter(Boolean).length} citing editable)`);
  console.log(`🔗 Attached ${healthCheckButtons.length} health check and ${hyperciteDeleteButtons.length} delete button listeners`);

  // Hide the manage SVG after injection
  svg.style.display = 'none';
}

/**
 * Handle health check button click for hypercites
 * @param {Event} event - The click event
 */
export async function handleHyperciteHealthCheck(event) {
  event.preventDefault();
  event.stopPropagation();

  const button = event.currentTarget;
  const citingBook = button.getAttribute('data-citing-book');
  const hyperciteId = button.getAttribute('data-hypercite-id');
  const contentType = button.getAttribute('data-content-type') || 'node';
  const contentItemId = button.getAttribute('data-content-item-id') || '';

  if (!citingBook || !hyperciteId) {
    console.error('Missing data attributes on health check button');
    return;
  }

  console.log(`🏥 Health check: book=${citingBook}, hypercite=${hyperciteId}, type=${contentType}, itemId=${contentItemId}`);

  // Find the delete button (sibling)
  const deleteButton = button.parentElement.querySelector('.hypercite-delete-btn');

  // Find the SVG element
  const svg = button.querySelector('svg');

  // Check if hypercite exists (in nodes, footnotes, or hyperlights depending on content type)
  const result = await checkHyperciteExists(citingBook, hyperciteId, contentType, contentItemId);

  // Add class to disable further interaction
  button.classList.add('health-check-complete');

  if (result.exists) {
    // Citation exists - change stethoscope to green, disable delete button
    svg.style.fill = '#22c55e';
    button.title = result.chunkKey ? `Found in chunk ${result.chunkKey}` : 'Citation exists';

    if (deleteButton) {
      deleteButton.disabled = true;
      deleteButton.title = "Can't delete - citation still exists";
    }
  } else {
    // Citation broken - change stethoscope to red, enable delete button
    svg.style.fill = '#ef4444';
    button.title = 'Citation not found - may have been deleted';

    if (deleteButton) {
      deleteButton.disabled = false;
      deleteButton.title = 'Delete this orphaned hypercite';
    }
  }

  // Don't reset - keep the result visible until container closes
}

/**
 * Remove specific broken citations from a hypercite's citedIN array
 * @param {string} sourceBook - The book containing the source hypercite
 * @param {Array<string>} sourceHyperciteIds - Array of source hypercite IDs
 * @param {Array<{url: string, sourceHyperciteId: string}>} brokenCitations - Citations to remove
 */
async function removeSpecificCitations(sourceBook, sourceHyperciteIds, brokenCitations) {
  const { queueForSync, debouncedMasterSync, updateBookTimestamp } = await import('../../indexedDB/index.js');
  const db = await openDatabase();

  const brokenUrls = brokenCitations.map(c => c.url);
  console.log(`🔧 Removing citations: ${JSON.stringify(brokenUrls)}`);

  const updatedNodeChunks = [];

  for (const sourceHyperciteId of sourceHyperciteIds) {
    // Read hypercite from IndexedDB
    const readTx = db.transaction('hypercites', 'readonly');
    const readStore = readTx.objectStore('hypercites');
    const hyperciteRequest = readStore.get([sourceBook, sourceHyperciteId]);

    const hypercite = await new Promise((resolve, reject) => {
      hyperciteRequest.onsuccess = () => resolve(hyperciteRequest.result);
      hyperciteRequest.onerror = () => reject(hyperciteRequest.error);
    });

    await new Promise((resolve, reject) => {
      readTx.oncomplete = () => resolve();
      readTx.onerror = () => reject(readTx.error);
    });

    if (!hypercite) {
      console.warn(`⚠️ Hypercite ${sourceHyperciteId} not found in IndexedDB`);
      continue;
    }

    // Filter out broken citations from citedIN array
    const originalLength = hypercite.citedIN ? hypercite.citedIN.length : 0;
    hypercite.citedIN = (hypercite.citedIN || []).filter(url => !brokenUrls.includes(url));
    const newLength = hypercite.citedIN.length;

    console.log(`📊 Updated citedIN: ${originalLength} → ${newLength} citations`);

    // Update relationship status based on new citedIN length
    if (newLength === 0) {
      hypercite.relationshipStatus = 'single';
    } else if (newLength === 1) {
      hypercite.relationshipStatus = 'couple';
    } else {
      hypercite.relationshipStatus = 'poly';
    }

    console.log(`🔄 Updated relationship status: ${hypercite.relationshipStatus}`);

    // Save updated hypercite to IndexedDB
    const writeTx = db.transaction('hypercites', 'readwrite');
    const writeStore = writeTx.objectStore('hypercites');
    const putRequest = writeStore.put(hypercite);

    await new Promise((resolve, reject) => {
      putRequest.onsuccess = () => {
        console.log(`✅ Updated hypercite ${sourceHyperciteId} in IndexedDB`);
        resolve();
      };
      putRequest.onerror = () => reject(putRequest.error);
    });

    await new Promise((resolve, reject) => {
      writeTx.oncomplete = () => resolve();
      writeTx.onerror = () => reject(writeTx.error);
    });

    // Queue for sync to PostgreSQL
    queueForSync('hypercites', sourceHyperciteId, 'update', hypercite);

    // Update DOM if element exists
    const uElement = document.getElementById(sourceHyperciteId);
    if (uElement) {
      // Update class to reflect new relationship status
      uElement.classList.remove('single', 'couple', 'poly');
      uElement.classList.add(hypercite.relationshipStatus);
      console.log(`✅ Updated DOM element class to ${hypercite.relationshipStatus}`);
    }

    // 🔥 NEW: Update nodeChunk's hypercites array (like delinkHypercite does)
    // This ensures the embedded hypercite data in nodes stays in sync
    const nodesTx = db.transaction(['nodes'], 'readwrite');
    const nodesStore = nodesTx.objectStore('nodes');
    const bookIndex = nodesStore.index('book');

    // Get all nodes for this book
    const allNodeChunks = await new Promise((resolve, reject) => {
      const request = bookIndex.getAll(sourceBook);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    console.log(`🔍 Searching ${allNodeChunks.length} nodes for hypercite ${sourceHyperciteId}`);

    // Find the nodeChunk that contains this hypercite
    let foundNodeChunk = null;
    let foundHyperciteIndex = -1;

    for (const nodeChunk of allNodeChunks) {
      if (nodeChunk.hypercites && Array.isArray(nodeChunk.hypercites)) {
        const index = nodeChunk.hypercites.findIndex(hc => hc.hyperciteId === sourceHyperciteId);
        if (index !== -1) {
          foundNodeChunk = nodeChunk;
          foundHyperciteIndex = index;
          console.log(`✅ Found hypercite in nodeChunk at startLine ${nodeChunk.startLine}, index ${index}`);
          break;
        }
      }
    }

    if (foundNodeChunk && foundHyperciteIndex !== -1) {
      // Update the hypercite in the nodeChunk's array
      foundNodeChunk.hypercites[foundHyperciteIndex] = {
        ...foundNodeChunk.hypercites[foundHyperciteIndex],
        citedIN: hypercite.citedIN,
        relationshipStatus: hypercite.relationshipStatus
      };

      // Update the nodeChunk in IndexedDB
      const updateRequest = nodesStore.put(foundNodeChunk);
      await new Promise((resolve, reject) => {
        updateRequest.onsuccess = () => resolve();
        updateRequest.onerror = () => reject(updateRequest.error);
      });

      console.log(`✅ Updated nodeChunk hypercites array for startLine ${foundNodeChunk.startLine}`);

      // Queue the nodeChunk for sync to PostgreSQL
      queueForSync('nodes', foundNodeChunk.startLine, 'update', foundNodeChunk);
      updatedNodeChunks.push(foundNodeChunk);
    } else {
      console.warn(`⚠️ Hypercite ${sourceHyperciteId} not found in any nodeChunk`);
    }

    await new Promise((resolve, reject) => {
      nodesTx.oncomplete = () => resolve();
      nodesTx.onerror = () => reject(nodesTx.error);
    });
  }

  // Update book timestamp
  await updateBookTimestamp(sourceBook);

  // Flush sync immediately
  console.log('⚡ Flushing sync queue immediately...');
  await debouncedMasterSync.flush();
  console.log('✅ Sync queue flushed');

  // Broadcast changes to other tabs
  const { broadcastToOpenTabs } = await import('../../utilities/BroadcastListener.js');
  updatedNodeChunks.forEach(chunk => {
    broadcastToOpenTabs(sourceBook, chunk.startLine);
  });
  console.log('📡 Broadcasted citation removal to other tabs');
}

/**
 * Handle delete button click for hypercites
 * @param {Event} event - The click event
 */
export async function handleHyperciteDelete(event) {
  event.preventDefault();
  event.stopPropagation();

  const button = event.currentTarget;
  const sourceBook = button.getAttribute('data-source-book');
  const sourceHyperciteIdStr = button.getAttribute('data-source-hypercite-id');
  const citationUrl = button.getAttribute('data-citation-url');

  if (!sourceBook || !sourceHyperciteIdStr || !citationUrl) {
    console.error('Missing data attributes on delete button');
    return;
  }

  // Handle comma-separated IDs (for overlapping hypercites)
  const sourceHyperciteIds = sourceHyperciteIdStr.split(',').map(id => id.trim());

  console.log(`🗑️ Deleting specific citation: ${citationUrl} from hypercite(s): ${sourceHyperciteIds.join(', ')}`);

  // Confirm deletion
  if (!confirm(`Delete this citation link?\n\n${citationUrl}`)) {
    return;
  }

  try {
    // Remove this specific citation from the citedIN array
    await removeSpecificCitations(sourceBook, sourceHyperciteIds, [{ url: citationUrl }]);

    // Import closeHyperlitContainer from core
    const { closeHyperlitContainer } = await import('../core.js');

    // Close container and reload to show updated state
    closeHyperlitContainer();
    console.log('✅ Removed citation successfully');
    return;
  } catch (error) {
    console.error('❌ Error deleting citation:', error);
    alert('Failed to delete citation. Please try again.');
    return;
  }
}

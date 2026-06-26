/**
 * Hypercite content builder — constructs the "Cited By" panel HTML for the hyperlit container.
 * Pure render: reads hypercite + library data, formats citations, and emits per-citation
 * blockquotes with a deferred `.hypercite-management-buttons` placeholder (filled in later by
 * the citation-management handlers).
 */

import { openDatabase } from '../../../indexedDB/index';
import type { HyperciteRecord } from '../../../indexedDB/types';
import { formatBibtexToCitation } from "../../../utilities/bibtexProcessor";
import DOMPurify from 'dompurify';
import { showTargetNotFoundToast } from '../../../components/toast/toast';
import { privateLockIcon } from '../sourceAccessButton';
import { sanitizeUrl, parseCitedInLink } from './hyperciteLinks';

/**
 * Build hypercite content section.
 * @param contentType - The hypercite content type object
 * @param db - Reused database connection
 * @returns HTML string for hypercite content
 */
export async function buildHyperciteContent(contentType: any, db: any = null) {
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
        const hyperciteData: HyperciteRecord | undefined = await new Promise((resolve: any, reject: any) => {
          getRequest.onsuccess = () => resolve(getRequest.result);
          getRequest.onerror = () => reject(getRequest.error);
        });

        if (hyperciteData) {
          hyperciteDataArray.push(hyperciteData);
        }
      }
    }

    if (hyperciteDataArray.length === 0) {
      const missingIds = (hyperciteIds || [hyperciteId]).filter(Boolean);
      console.warn(`⚠️ Hypercite data not found in IndexedDB for: ${missingIds.join(', ')}`);
      showTargetNotFoundToast({ target: missingIds[0] || 'hypercite' });
      return `
        <div class="hypercites-section">
          <b>Hypercite</b>
          <div class="error">Hypercite data not found (id: ${missingIds.join(', ') || 'unknown'}). It may have been deleted, or this book hasn't finished loading yet.</div>
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
    const citedINLinksWithIds: any[] = [];
    for (const hyperciteData of hyperciteDataArray) {
      if (Array.isArray(hyperciteData.citedIN) && hyperciteData.citedIN.length > 0) {
        hyperciteData.citedIN.forEach((link: any) => {
          citedINLinksWithIds.push({
            link: link,
            hyperciteId: hyperciteData.hyperciteId
          });
        });
      }
    }

    // Remove duplicates based on link URL (but keep the hyperciteId association)
    const uniqueCitedINLinks = citedINLinksWithIds.filter((item: any, index: any, self: any) =>
      index === self.findIndex((t: any) => t.link === item.link)
    );

    if (uniqueCitedINLinks.length > 0) {
      // 🚀 PERFORMANCE: Extract all bookIDs first
      const citationMetadata = uniqueCitedINLinks.map((citationItem: any) =>
        parseCitedInLink(citationItem.link, citationItem.hyperciteId)
      );

      // 🚀 PERFORMANCE: Batch all library queries at once
      const uniqueBookIDs = [...new Set(citationMetadata.map((m: any) => m.bookID))];
      console.log(`⚡ Batch fetching ${uniqueBookIDs.length} library records instead of ${citationMetadata.length} sequential queries`);

      const libraryTx = database.transaction("library", "readonly");
      const libraryStore = libraryTx.objectStore("library");
      const libraryDataMap = new Map();

      await Promise.all(uniqueBookIDs.map((bookID: any) =>
        new Promise((resolve: any) => {
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
      const { fetchLibraryFromServer }: any = await import('../../utils.js');

      // 🚀 PERFORMANCE: Process all citations with cached library data
      const linksHTML: any = await Promise.all(
        citationMetadata.map(async (meta: any) => {
          const { citationID, hyperciteId, bookID, isHyperlightURL, isFootnoteURL, hasHyperciteInUrl, hyperciteIdFromUrl, contentType, contentItemId, subBookId } = meta;

          // 🚀 PERFORMANCE: Skip permission check during initial render (deferred to post-render)
          // Add placeholder for management buttons that will be injected asynchronously
          let managementButtonsHtml = '';
          if (hasHyperciteInUrl) {
            // Use hyperciteId (the actual owner of this citedIN link) not originalHyperciteId (the clicked hypercite)
            // This matters for overlapping hypercites where citations from different sources are displayed together
            managementButtonsHtml = `
      <span class="hypercite-management-buttons" data-book-id="${bookID}" data-citation-url="${citationID}" data-hypercite-id="${hyperciteIdFromUrl}" data-source-hypercite-id="${hyperciteId}" data-content-type="${contentType}" data-content-item-id="${contentItemId}" data-sub-book-id="${subBookId}">
        <!-- Buttons will be injected after permission check -->
      </span>
    `;
          }

          // Get library data from cached map
          let libraryData = libraryDataMap.get(bookID);
          console.log(`📚 Library lookup for bookID: "${bookID}", IndexedDB hit: ${!!libraryData}, has bibtex: ${!!libraryData?.bibtex}`);

          // Fallback to server if not in IndexedDB
          if (!libraryData || !libraryData.bibtex) {
            libraryData = await fetchLibraryFromServer(bookID);
            console.log(`📡 Server fetch result for "${bookID}": ${libraryData ? 'found' : 'null'}, bibtex: ${!!libraryData?.bibtex}`);
          }

          if (libraryData && libraryData.bibtex) {
            const rawFormattedCitation: any = await formatBibtexToCitation(libraryData.bibtex);
            // Sanitize citation to prevent XSS from malicious bibtex data
            const formattedCitation = DOMPurify.sanitize(rawFormattedCitation, { ALLOWED_TAGS: ['i', 'em', 'b', 'strong'] });

            // Check if the book is private and add lock icon
            const isPrivate = libraryData.visibility === 'private';
            const lockIcon = isPrivate ? privateLockIcon('margin-left: -20px;') : '';

            const citationText = (isHyperlightURL && isFootnoteURL)
              ? `${lockIcon}a <span id="citedInHyperlight">Hyperlight</span> within a <span id="citedInFootnote">Footnote</span> within ${formattedCitation}`
              : isHyperlightURL
              ? `${lockIcon}a <span id="citedInHyperlight">Hyperlight</span> within ${formattedCitation}`
              : isFootnoteURL
              ? `${lockIcon}a <span id="citedInFootnote">Footnote</span> within ${formattedCitation}`
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
            // Graceful fallback: show location description + bookID instead of raw URL
            const locationText = (isHyperlightURL && isFootnoteURL)
              ? 'a Hyperlight within a Footnote within'
              : isHyperlightURL ? 'a Hyperlight within'
              : isFootnoteURL ? 'a Footnote within'
              : '';
            const displayBookID = DOMPurify.sanitize(bookID, { ALLOWED_TAGS: [] });
            const linkText = locationText
              ? `${locationText} ${displayBookID}`
              : displayBookID;
            return `<blockquote>${linkText} <a href="${safeHref}" class="citation-link" data-content-id="${hyperciteId}"><span class="open-icon">↗</span></a>${managementButtonsHtml}</blockquote>`;
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

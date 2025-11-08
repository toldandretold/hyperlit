/**
 * Hypercite Container & UI Generation
 *
 * Creates and manages UI for displaying hypercite citations ("cited by" containers).
 * Handles both single and overlapping hypercites with BibTeX citation formatting.
 */

import { openDatabase } from '../indexedDB.js';
import { fetchLibraryFromServer } from './database.js';
import { book } from '../app.js';
import { formatBibtexToCitation } from "../utilities/bibtexProcessor.js";
import { canUserEditBook } from "../utilities/auth.js";
import { openHyperlitContainer } from '../hyperlitContainer/index.js';

/**
 * Handle poly click - shows "cited by" container with all citations
 * @param {Event} event - The click event
 */
export async function PolyClick(event) {
  // Prevent default click action if needed
  event.preventDefault();

  // Get hyperciteId from the clicked element
  const hyperciteId = event.target.id;

  if (!hyperciteId) {
    console.error("❌ Could not determine hypercite ID.");
    return;
  }

  console.log(`u.poly clicked: ${hyperciteId}`);

  try {
    const db = await openDatabase();
    const tx = db.transaction("hypercites", "readonly");
    const store = tx.objectStore("hypercites");
    const index = store.index("hyperciteId");

    const getRequest = index.get(hyperciteId);

    getRequest.onsuccess = async () => {
      const hyperciteData = getRequest.result;
      console.log("Found hypercite data:", hyperciteData);

      if (!hyperciteData) {
        console.error("❌ No hypercite data found for ID:", hyperciteId);
        return;
      }

      // If your hyperciteData contains a citedIN array, we build the container's content based on that.
      let linksHTML = "";
      if (Array.isArray(hyperciteData.citedIN) && hyperciteData.citedIN.length > 0) {
        linksHTML = (
          await Promise.all(
            hyperciteData.citedIN.map(async (citationID) => {
              return await formatCitationLink(db, citationID, false);
            })
          )
        ).join("");  // ← join with the empty string
      } else {
        linksHTML = "<p>No citations available.</p>";
      }

      const containerContent = `
        <div class="scroller">
          <h1> Cited By: </h1>
          <p></p>
          <div class="citation-links">
            ${linksHTML}
          </div>
        </div>
        <div class="mask-bottom"></div>
        <div class="mask-top"></div>
      `;

      // Open the hypercite container with the generated content
      openHyperlitContainer(containerContent);

      // Double-check that the container exists and has content
      const hyperciteContainer =
        document.getElementById("hypercite-container");
      if (!hyperciteContainer) {
        console.error("❌ Hypercite container element not found in DOM");
        return;
      }
      console.log("Container state:", {
        exists: !!hyperciteContainer,
        content: hyperciteContainer.innerHTML,
        isVisible: hyperciteContainer.classList.contains("open"),
      });
    };

    getRequest.onerror = (event) => {
      console.error("❌ Error fetching hypercite data:", event.target.error);
    };

  } catch (error) {
    console.error("❌ Error accessing IndexedDB:", error);
  }
}

/**
 * Create and open the poly container for overlapping hypercites
 * @param {Array} allCitedINLinks - All citedIN links from overlapping hypercites
 * @param {Array} validHypercites - All valid hypercite objects
 */
export async function createOverlappingPolyContainer(allCitedINLinks, validHypercites) {
  const db = await openDatabase();

  // Remove duplicates from citedIN links
  const uniqueLinks = [...new Set(allCitedINLinks)];

  // Extract all overlapping hypercite IDs and the source book
  const overlappingHyperciteIds = validHypercites.map(hc => hc.hyperciteId);
  const sourceBook = validHypercites.length > 0 ? validHypercites[0].book : book;

  // Generate HTML for all links with management buttons
  const linksHTML = (
    await Promise.all(
      uniqueLinks.map(async (citationID) => {
        return await formatCitationLink(db, citationID, true, sourceBook, overlappingHyperciteIds);
      })
    )
  ).join("");

  const containerContent = `
    <div class="scroller">
      <div class="hypercites-section">
        <h1>Cited By</h1>

        <div class="citation-links">
          ${linksHTML}
        </div>
        <hr>
      </div>
    </div>
    <div class="mask-bottom"></div>
    <div class="mask-top"></div>
  `;

  // Open the hypercite container with the generated content
  openHyperlitContainer(containerContent);

  // Attach event listeners for management buttons after container opens
  setTimeout(async () => {
    const healthCheckButtons = document.querySelectorAll('.hypercite-health-check-btn');
    const hyperciteDeleteButtons = document.querySelectorAll('.hypercite-delete-btn');

    if (healthCheckButtons.length > 0 || hyperciteDeleteButtons.length > 0) {
      // Import handlers from hyperlitContainer
      const { handleHyperciteHealthCheck, handleHyperciteDelete } = await import('../hyperlitContainer/index.js');

      healthCheckButtons.forEach(button => {
        button.addEventListener('click', handleHyperciteHealthCheck);
      });

      hyperciteDeleteButtons.forEach(button => {
        button.addEventListener('click', handleHyperciteDelete);
      });

      console.log(`🔗 Attached ${healthCheckButtons.length} health check and ${hyperciteDeleteButtons.length} delete button listeners in overlapping container`);
    }
  }, 200);
}

/**
 * Format a single citation link as HTML
 * @param {IDBDatabase} db - The IndexedDB database
 * @param {string} citationID - The citation URL
 * @param {boolean} includeManagementButtons - Whether to include health check/delete buttons
 * @param {string} sourceBook - The source book (for management buttons)
 * @param {Array<string>} overlappingHyperciteIds - Array of overlapping IDs (for management buttons)
 * @returns {Promise<string>} - HTML string for the citation link
 */
async function formatCitationLink(db, citationID, includeManagementButtons = false, sourceBook = null, overlappingHyperciteIds = []) {
  // Extract the book/citation ID from the URL with improved handling
  let bookID;
  const citationParts = citationID.split("#");
  const urlPart = citationParts[0];

  // Check if this is a hyperlight URL (contains /HL_)
  const isHyperlightURL = urlPart.includes("/HL_");

  if (isHyperlightURL) {
    // For URLs like "/nicholls2019moment/HL_1747630135510#hypercite_5k2bmvr6"
    // Extract the book ID from the path before the /HL_ part
    const pathParts = urlPart.split("/");
    // Find the part before the HL_ segment
    for (let i = 0; i < pathParts.length; i++) {
      if (pathParts[i].startsWith("HL_") && i > 0) {
        bookID = pathParts[i-1];
        break;
      }
    }

    // If we couldn't find it with the above method, fall back to taking the first non-empty path segment
    if (!bookID) {
      bookID = pathParts.filter(part => part && !part.startsWith("HL_"))[0] || "";
    }
  } else {
    // Original simple case: url.com/book#id
    bookID = urlPart.replace("/", "");
  }

  // Check if this is a simple hypercite and user owns the CITING book
  const isSimpleHypercite = !isHyperlightURL && citationParts.length > 1;
  let managementButtonsHtml = '';

  if (includeManagementButtons && isSimpleHypercite) {
    const hyperciteIdFromUrl = citationParts[1]; // Extract hypercite_xxx

    // Check if user can edit the CITING book (from href/citedIN)
    const canEdit = await canUserEditBook(bookID);

    if (canEdit) {
      // For overlapping hypercites, pass all overlapping IDs (comma-separated)
      managementButtonsHtml = `
      <span class="hypercite-management-buttons">
        <button class="hypercite-health-check-btn"
                data-citing-book="${bookID}"
                data-hypercite-id="${hyperciteIdFromUrl}"
                data-citation-url="${citationID}"
                title="Check if citation exists"
                type="button">
          <svg width="18" height="18" viewBox="0 0 48 48" fill="currentColor">
            <path d="M12 10C13.1046 10 14 9.10457 14 8C14 6.89543 13.1046 6 12 6C11.2597 6 10.6134 6.4022 10.2676 7H10C8.34315 7 7 8.34315 7 10V19C6.44774 19 5.99531 19.4487 6.04543 19.9987C6.27792 22.5499 7.39568 24.952 9.22186 26.7782C10.561 28.1173 12.2098 29.0755 14 29.583V32C14 33.3064 14.835 34.4177 16.0004 34.8294C16.043 38.7969 19.2725 42 23.25 42C27.2541 42 30.5 38.7541 30.5 34.75V30.75C30.5 28.6789 32.1789 27 34.25 27C36.3211 27 38 28.6789 38 30.75V33.1707C36.8348 33.5825 36 34.6938 36 36C36 37.6569 37.3431 39 39 39C40.6569 39 42 37.6569 42 36C42 34.6938 41.1652 33.5825 40 33.1707V30.75C40 27.5744 37.4256 25 34.25 25C31.0744 25 28.5 27.5744 28.5 30.75V34.75C28.5 37.6495 26.1495 40 23.25 40C20.3769 40 18.0429 37.6921 18.0006 34.8291C19.1655 34.4171 20 33.306 20 32V29.583C21.7902 29.0755 23.4391 28.1173 24.7782 26.7782C26.6044 24.952 27.7221 22.5499 27.9546 19.9987C28.0048 19.4487 27.5523 19 27 19L27 10C27 8.34315 25.6569 7 24 7H23.7324C23.3866 6.4022 22.7403 6 22 6C20.8954 6 20 6.89543 20 8C20 9.10457 20.8954 10 22 10C22.7403 10 23.3866 9.5978 23.7324 9H24C24.5523 9 25 9.44772 25 10V19H25.2095C24.6572 19 24.2166 19.4499 24.1403 19.9969C23.9248 21.5406 23.2127 22.983 22.0979 24.0979C20.7458 25.4499 18.9121 26.2095 17 26.2095C15.088 26.2095 13.2542 25.4499 11.9022 24.0979C10.7873 22.983 10.0753 21.5406 9.8598 19.9969C9.78344 19.4499 9.34286 19 8.79057 19L9 19V10C9 9.44772 9.44772 9 10 9H10.2676C10.6134 9.5978 11.2597 10 12 10Z"/>
          </svg>
        </button>
        <button class="hypercite-delete-btn"
                data-source-book="${sourceBook}"
                data-source-hypercite-id="${overlappingHyperciteIds.join(',')}"
                data-citation-url="${citationID}"
                title="Run health check first"
                type="button"
                disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18" stroke-linecap="round" stroke-linejoin="round"></path>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke-linecap="round" stroke-linejoin="round"></path>
          </svg>
        </button>
      </span>
    `;
    }
  }

  // Check if the book exists in the library object store
  const libraryTx = db.transaction("library", "readonly");
  const libraryStore = libraryTx.objectStore("library");
  const libraryRequest = libraryStore.get(bookID);

  return new Promise((resolve) => {
    libraryRequest.onsuccess = async () => {
      const libraryData = libraryRequest.result;

      if (libraryData && libraryData.bibtex) {
        // Format the BibTeX data into an academic citation
        const formattedCitation = await formatBibtexToCitation(libraryData.bibtex);

        // Customize the citation display based on URL type
        const citationText = isHyperlightURL
          ? `a <span id="citedInHyperlight">Hyperlight</span> in ${formattedCitation}`
          : formattedCitation;

        // Return the formatted citation with the clickable link
        resolve(
          `<blockquote>${citationText} <a href="${citationID}" class="citation-link"><span class="open-icon">↗</span></a>${managementButtonsHtml}</blockquote>`
        );
      } else {
        // Fallback: try to fetch from server
        fetchLibraryFromServer(bookID).then(async (serverLibraryData) => {
          if (serverLibraryData && serverLibraryData.bibtex) {
            const formattedCitation = await formatBibtexToCitation(serverLibraryData.bibtex);
            const citationText = isHyperlightURL
              ? `a <span id="citedInHyperlight">Hyperlight</span> in ${formattedCitation}`
              : formattedCitation;

            resolve(
              `<blockquote>${citationText} <a href="${citationID}" class="citation-link"><span class="open-icon">↗</span></a>${managementButtonsHtml}</blockquote>`
            );
          } else {
            resolve(`<a href="${citationID}" class="citation-link">${citationID}${managementButtonsHtml}</a>`);
          }
        });
      }
    };

    libraryRequest.onerror = () => {
      console.error(`❌ Error fetching library data for book ID: ${bookID}`);
      // Fallback: try to fetch from server
      fetchLibraryFromServer(bookID).then(async (serverLibraryData) => {
        if (serverLibraryData && serverLibraryData.bibtex) {
          const formattedCitation = await formatBibtexToCitation(serverLibraryData.bibtex);
          const citationText = isHyperlightURL
            ? `a <span id="citedInHyperlight">Hyperlight</span> in ${formattedCitation}`
            : formattedCitation;

          resolve(
            `<blockquote>${citationText} <a href="${citationID}" class="citation-link"><span class="open-icon">↗</span></a>${managementButtonsHtml}</blockquote>`
          );
        } else {
          resolve(`<a href="${citationID}" class="citation-link">${citationID}${managementButtonsHtml}</a>`);
        }
      });
    };
  });
}

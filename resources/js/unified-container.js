// unified-container.js - Unified system for all hyperlit content types
import { book } from "./app.js";
import { openDatabase } from "./cache-indexedDB.js";
import { ContainerManager } from "./container-manager.js";
import { formatBibtexToCitation } from "./bibtexProcessor.js";
import { getCurrentUserId } from "./auth.js";

// Create the unified container manager
let hyperlitManager = null;

export function initializeHyperlitManager() {
  console.log("🔄 Initializing Unified Hyperlit Container Manager...");
  hyperlitManager = new ContainerManager(
    "hyperlit-container", 
    "ref-overlay", 
    null, 
    ["main-content", "nav-buttons"]
  );
}

export function openHyperlitContainer(content) {
  if (!hyperlitManager) {
    initializeHyperlitManager();
  }
  hyperlitManager.openContainer(content);
}

export function closeHyperlitContainer() {
  if (!hyperlitManager) {
    initializeHyperlitManager();
  }
  hyperlitManager.closeContainer();
}

// Helper function to format relative time
function formatRelativeTime(timeSince) {
  if (!timeSince) return 'prehistoric';
  
  const now = Math.floor(Date.now() / 1000);
  const diffSeconds = now - timeSince;
  
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffSeconds / 3600);
  const diffDays = Math.floor(diffSeconds / 86400);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);
  
  if (diffMinutes < 1) return 'now';
  if (diffMinutes < 60) return `${diffMinutes}min`;
  if (diffHours < 24) return `${diffHours}hr`;
  if (diffDays < 7) return `${diffDays}d`;
  if (diffWeeks < 4) return `${diffWeeks}w`;
  if (diffMonths < 12) return `${diffMonths}m`;
  return `${diffYears}y`;
}

/**
 * Main function to handle any element click and detect all overlapping content types
 * @param {HTMLElement} element - The clicked element
 * @param {Array} highlightIds - Optional array of highlight IDs if already known
 * @param {Array} newHighlightIds - Optional array of new highlight IDs
 */
export async function handleUnifiedContentClick(element, highlightIds = null, newHighlightIds = []) {
  try {
    console.log("🎯 Unified content click handler triggered", element);
    
    // Detect all content types on this element
    const contentTypes = await detectContentTypes(element, highlightIds);
    
    if (contentTypes.length === 0) {
      console.log("No hyperlit content detected on element");
      return;
    }
    
    console.log(`📊 Detected content types: ${contentTypes.map(c => c.type).join(', ')}`);
    
    // Build unified content
    const unifiedContent = await buildUnifiedContent(contentTypes, newHighlightIds);
    
    // Open the unified container
    openHyperlitContainer(unifiedContent);
    
    // Handle any post-open actions (like cursor placement for editable content)
    await handlePostOpenActions(contentTypes, newHighlightIds);
    
  } catch (error) {
    console.error("❌ Error in unified content handler:", error);
  }
}

/**
 * Detect all content types present on an element
 * @param {HTMLElement} element - The element to analyze
 * @param {Array} providedHighlightIds - Optional highlight IDs if already known
 * @returns {Array} Array of content type objects
 */
async function detectContentTypes(element, providedHighlightIds = null) {
  const contentTypes = [];
  
  // 1. Check for footnotes (highest priority)
  const footnoteData = detectFootnote(element);
  if (footnoteData) {
    contentTypes.push(footnoteData);
  }
  
  // 2. Check for citations
  const citationData = detectCitation(element);
  if (citationData) {
    contentTypes.push(citationData);
  }
  
  // 3. Check for hyperlights
  const highlightData = await detectHighlights(element, providedHighlightIds);
  if (highlightData) {
    contentTypes.push(highlightData);
  }
  
  // 4. Check for hypercites
  const hyperciteData = await detectHypercites(element);
  if (hyperciteData) {
    contentTypes.push(hyperciteData);
  }
  
  return contentTypes;
}

/**
 * Detect footnote content
 */
function detectFootnote(element) {
  // Check if element is a sup with fn-count-id
  if (element.tagName === 'SUP' && element.hasAttribute('fn-count-id')) {
    return {
      type: 'footnote',
      element: element,
      fnCountId: element.getAttribute('fn-count-id'),
      elementId: element.id
    };
  }
  
  // Check if it's a footnote link inside a sup
  if (element.tagName === 'A' && element.classList.contains('footnote-ref')) {
    const supElement = element.closest('sup[fn-count-id]');
    if (supElement) {
      return {
        type: 'footnote',
        element: supElement,
        fnCountId: supElement.getAttribute('fn-count-id'),
        elementId: supElement.id
      };
    }
  }
  
  return null;
}

/**
 * Detect citation content
 */
function detectCitation(element) {
  if (element.tagName === 'A' && element.classList.contains('in-text-citation')) {
    const href = element.getAttribute('href');
    if (href && href.startsWith('#')) {
      return {
        type: 'citation',
        element: element,
        referenceId: href.substring(1)
      };
    }
  }
  
  return null;
}

/**
 * Detect highlight content
 */
async function detectHighlights(element, providedHighlightIds = null) {
  let highlightIds = providedHighlightIds;
  
  // If not provided, extract from element classes
  if (!highlightIds && element.tagName === 'MARK') {
    highlightIds = Array.from(element.classList).filter(cls => cls.startsWith('HL_'));
  }
  
  if (!highlightIds || highlightIds.length === 0) {
    return null;
  }
  
  return {
    type: 'highlight',
    element: element,
    highlightIds: highlightIds
  };
}

/**
 * Detect hypercite content
 */
async function detectHypercites(element) {
  // Check for underlined elements with hypercite classes
  if (element.tagName === 'U' && (element.classList.contains('couple') || element.classList.contains('poly') || element.classList.contains('single'))) {
    return {
      type: 'hypercite',
      element: element,
      hyperciteId: element.id,
      relationshipStatus: element.classList.contains('couple') ? 'couple' : 
                          element.classList.contains('poly') ? 'poly' : 'single'
    };
  }
  
  return null;
}

/**
 * Build unified content HTML from detected content types
 */
async function buildUnifiedContent(contentTypes, newHighlightIds = []) {
  let html = `<div class="scroller">\n`;
  
  // Process each content type in priority order
  for (const contentType of contentTypes) {
    switch (contentType.type) {
      case 'footnote':
        const footnoteHtml = await buildFootnoteContent(contentType);
        if (footnoteHtml) {
          html += footnoteHtml;
        }
        break;
        
      case 'citation':
        const citationHtml = await buildCitationContent(contentType);
        if (citationHtml) {
          html += citationHtml;
        }
        break;
        
      case 'highlight':
        const highlightHtml = await buildHighlightContent(contentType, newHighlightIds);
        if (highlightHtml) {
          html += highlightHtml;
        }
        break;
        
      case 'hypercite':
        const hyperciteHtml = await buildHyperciteContent(contentType);
        if (hyperciteHtml) {
          html += hyperciteHtml;
        }
        break;
    }
  }
  
  html += `</div>\n`;
  html += `<div class="mask-bottom"></div>\n`;
  html += `<div class="mask-top"></div>\n`;
  html += `<div class="container-controls">\n`;
  html += `<div class="resize-handle resize-left" title="Resize width"></div>\n`;
  html += `<div class="drag-handle" title="Drag to move container"></div>\n`;
  html += `<div class="resize-handle resize-right" title="Resize width"></div>\n`;
  html += `</div>`;
  
  return html;
}

/**
 * Build footnote content section
 */
async function buildFootnoteContent(contentType) {
  try {
    const { elementId } = contentType;
    
    // Extract footnote ID (remove "ref" suffix if present)
    let footnoteId = elementId;
    if (footnoteId.includes('ref')) {
      footnoteId = footnoteId.replace('ref', '');
    }
    
    const db = await openDatabase();
    const transaction = db.transaction(["footnotes"], "readonly");
    const store = transaction.objectStore("footnotes");
    
    const key = [book, footnoteId];
    const result = await new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    
    if (result && result.content) {
      return `
        <div class="footnotes-section">
          <h3>Footnote:</h3>
          <div class="footnote-content">
            <div class="footnote-text">${result.content}</div>
          </div>
          <hr>
        </div>`;
    } else {
      return `
        <div class="footnotes-section">
          <h3>Footnote:</h3>
          <div class="error">Footnote not found: ${footnoteId}</div>
          <hr>
        </div>`;
    }
  } catch (error) {
    console.error('Error building footnote content:', error);
    return `
      <div class="footnotes-section">
        <h3>Footnote:</h3>
        <div class="error">Error loading footnote</div>
        <hr>
      </div>`;
  }
}

/**
 * Build citation content section
 */
async function buildCitationContent(contentType) {
  try {
    const { referenceId } = contentType;
    
    const db = await openDatabase();
    const transaction = db.transaction(["references"], "readonly");
    const store = transaction.objectStore("references");
    
    const key = [book, referenceId];
    const result = await new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    
    if (result && result.content) {
      return `
        <div class="citations-section">
          <h3>Citation:</h3>
          <div class="citation-content">
            <div class="citation-text">${result.content}</div>
          </div>
          <hr>
        </div>`;
    } else {
      return `
        <div class="citations-section">
          <h3>Citation:</h3>
          <div class="error">Reference not found: ${referenceId}</div>
          <hr>
        </div>`;
    }
  } catch (error) {
    console.error('Error building citation content:', error);
    return `
      <div class="citations-section">
        <h3>Citation:</h3>
        <div class="error">Error loading reference</div>
        <hr>
      </div>`;
  }
}

/**
 * Build highlight content section
 */
async function buildHighlightContent(contentType, newHighlightIds = []) {
  try {
    const { highlightIds } = contentType;
    const currentUserId = await getCurrentUserId();
    
    const db = await openDatabase();
    const tx = db.transaction("hyperlights", "readonly");
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
    const validResults = results.filter((r) => r);
    
    if (validResults.length === 0) {
      return `
        <div class="highlights-section">
          <h3>Highlights:</h3>
          <div class="error">No highlight data found</div>
          <hr>
        </div>`;
    }

    let html = `<div class="highlights-section">\n<h3>Highlights:</h3>\n`;
    let firstUserAnnotation = null;

    validResults.forEach((h) => {
      const isUserHighlight = h.creator === currentUserId || h.creator_token === currentUserId;
      const isNewlyCreated = newHighlightIds.includes(h.hyperlight_id);
      const isEditable = isUserHighlight || isNewlyCreated;
      const authorName = h.creator || "Anon";
      const relativeTime = formatRelativeTime(h.time_since);

      html += `  <div class="author" id="${h.hyperlight_id}">\n`;
      html += `    <b>${authorName}</b><i class="time">・${relativeTime}</i>\n`;
      html += `  </div>\n`;
      html += `  <blockquote class="highlight-text" contenteditable="${isEditable}" `;
      html += `data-highlight-id="${h.hyperlight_id}">\n`;
      html += `    "${h.highlightedText}"\n`;
      html += `  </blockquote>\n`;
      html += `  <div class="annotation" contenteditable="${isEditable}" `;
      html += `data-highlight-id="${h.hyperlight_id}">\n`;
      html += `    ${h.annotation || ""}\n`;
      html += `  </div>\n`;
      html += `  <br>\n`;

      // Track first user annotation for cursor placement
      if (isEditable && !firstUserAnnotation) {
        firstUserAnnotation = h.hyperlight_id;
      }
    });
    
    html += `<hr>\n</div>\n`;
    
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
        <h3>Highlights:</h3>
        <div class="error">Error loading highlights</div>
        <hr>
      </div>`;
  }
}

/**
 * Build hypercite content section
 */
async function buildHyperciteContent(contentType) {
  try {
    const { hyperciteId, relationshipStatus } = contentType;
    
    if (relationshipStatus === 'single') {
      return `
        <div class="hypercites-section">
          <h3>Hypercite:</h3>
          <div class="hypercite-single">This is a single hypercite (not cited elsewhere)</div>
          <hr>
        </div>`;
    }
    
    const db = await openDatabase();
    const tx = db.transaction("hypercites", "readonly");
    const store = tx.objectStore("hypercites");
    const index = store.index("hyperciteId");

    const getRequest = index.get(hyperciteId);
    const hyperciteData = await new Promise((resolve, reject) => {
      getRequest.onsuccess = () => resolve(getRequest.result);
      getRequest.onerror = () => reject(getRequest.error);
    });

    if (!hyperciteData) {
      return `
        <div class="hypercites-section">
          <h3>Hypercite:</h3>
          <div class="error">Hypercite data not found</div>
          <hr>
        </div>`;
    }

    let html = `<div class="hypercites-section">\n<h3>Cited By:</h3>\n`;
    
    if (Array.isArray(hyperciteData.citedIN) && hyperciteData.citedIN.length > 0) {
      const linksHTML = await Promise.all(
        hyperciteData.citedIN.map(async (citationID) => {
          // Extract book ID from citation URL
          let bookID;
          const citationParts = citationID.split("#");
          const urlPart = citationParts[0];
          
          const isHyperlightURL = urlPart.includes("/HL_");
          
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
          } else {
            bookID = urlPart.replace("/", "");
          }

          // Get library data for formatted citation
          const libraryTx = db.transaction("library", "readonly");
          const libraryStore = libraryTx.objectStore("library");
          const libraryRequest = libraryStore.get(bookID);

          return new Promise((resolve) => {
            libraryRequest.onsuccess = async () => {
              const libraryData = libraryRequest.result;

              if (libraryData && libraryData.bibtex) {
                const formattedCitation = await formatBibtexToCitation(libraryData.bibtex);
                const citationText = isHyperlightURL 
                  ? `a <span id="citedInHyperlight">Hyperlight</span> in ${formattedCitation}` 
                  : formattedCitation;

                resolve(
                  `<p>${citationText} <a href="${citationID}" class="citation-link"><span class="open-icon">↗</span></a></p>`
                );
              } else {
                resolve(`<a href="${citationID}" class="citation-link">${citationID}</a>`);
              }
            };

            libraryRequest.onerror = () => {
              resolve(`<a href="${citationID}" class="citation-link">${citationID}</a>`);
            };
          });
        })
      );
      
      html += `<div class="citation-links">\n${linksHTML.join("")}\n</div>\n`;
    } else {
      html += `<p>No citations available.</p>\n`;
    }
    
    html += `<hr>\n</div>\n`;
    
    return html;
  } catch (error) {
    console.error('Error building hypercite content:', error);
    return `
      <div class="hypercites-section">
        <h3>Hypercite:</h3>
        <div class="error">Error loading hypercite data</div>
        <hr>
      </div>`;
  }
}

/**
 * Handle post-open actions like cursor placement
 */
async function handlePostOpenActions(contentTypes, newHighlightIds = []) {
  // Handle highlight-specific post-open actions
  const highlightType = contentTypes.find(ct => ct.type === 'highlight');
  if (highlightType) {
    // Import functions we need from hyperLights.js
    const { attachAnnotationListener, addHighlightContainerPasteListener, attachPlaceholderBehavior } = await import('./hyperLights.js');
    
    const { highlightIds } = highlightType;
    const currentUserId = await getCurrentUserId();
    
    // Get highlight data to determine which are editable
    const db = await openDatabase();
    const tx = db.transaction("hyperlights", "readonly");
    const store = tx.objectStore("hyperlights");
    const idx = store.index("hyperlight_id");

    const reads = highlightIds.map((id) =>
      new Promise((res, rej) => {
        const req = idx.get(id);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      })
    );

    const results = await Promise.all(reads);
    let firstUserAnnotation = null;

    // Attach listeners for editable highlights
    results.forEach((highlight) => {
      if (highlight) {
        const isUserHighlight = highlight.creator === currentUserId || highlight.creator_token === currentUserId;
        const isNewlyCreated = newHighlightIds.includes(highlight.hyperlight_id);
        const isEditable = isUserHighlight || isNewlyCreated;

        if (isEditable) {
          attachAnnotationListener(highlight.hyperlight_id);
          addHighlightContainerPasteListener(highlight.hyperlight_id);
          attachPlaceholderBehavior(highlight.hyperlight_id);
          
          if (!firstUserAnnotation) {
            firstUserAnnotation = highlight.hyperlight_id;
          }
        }
      }
    });

    // Place cursor in first user annotation if available
    if (firstUserAnnotation) {
      setTimeout(() => {
        const annotationDiv = document.querySelector(
          `.annotation[data-highlight-id="${firstUserAnnotation}"]`
        );
        if (annotationDiv) {
          const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
          
          if (!isMobile) {
            annotationDiv.focus();
            setTimeout(() => {
              try {
                const range = document.createRange();
                const selection = window.getSelection();
                range.selectNodeContents(annotationDiv);
                range.collapse(false);
                selection.removeAllRanges();
                selection.addRange(range);
              } catch (e) {
                console.log('Range selection not supported');
              }
            }, 50);
          }
        }
      }, 150);
    }
  }
}

// Export backward compatibility functions
export { hyperlitManager };
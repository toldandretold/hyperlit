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
  
  // Check if container exists in the DOM (should be there from blade template)
  const container = document.getElementById("hyperlit-container");
  if (!container) {
    console.error("❌ hyperlit-container not found in DOM! Check reader.blade.php");
    return;
  }
  console.log("✅ Found hyperlit-container in DOM");
  
  // Check if overlay exists (should be there from blade template)
  const overlay = document.getElementById("ref-overlay");
  if (!overlay) {
    console.error("❌ ref-overlay not found in DOM! Check reader.blade.php");
    return;
  }
  console.log("✅ Found ref-overlay in DOM");
  
  // Now create the manager with the existing container and overlay
  hyperlitManager = new ContainerManager(
    "hyperlit-container", 
    "ref-overlay", 
    null, 
    ["main-content", "nav-buttons"]
  );
  
  console.log("✅ Unified Hyperlit Container Manager initialized");
}

export function openHyperlitContainer(content) {
  if (!hyperlitManager) {
    initializeHyperlitManager();
  }
  
  // Get the container (should exist after initialization)
  const container = document.getElementById("hyperlit-container");
  if (!container) {
    console.error("❌ hyperlit-container not found after initialization!");
    return;
  }
  
  // Open the container using the manager FIRST
  console.log("📂 Opening container with manager first...");
  hyperlitManager.openContainer();
  
  // THEN set the content after the container is opened
  setTimeout(() => {
    const scroller = container.querySelector('.scroller');
    if (scroller) {
      console.log(`📝 Setting content in scroller AFTER opening (${content.length} chars)`);
      scroller.innerHTML = content;
      console.log(`✅ Content set after opening. Scroller innerHTML length: ${scroller.innerHTML.length}`);
      
      // Double-check the content is actually there
      setTimeout(() => {
        const recheckScroller = document.querySelector('#hyperlit-container .scroller');
        console.log(`🔍 Final recheck - Scroller innerHTML length: ${recheckScroller ? recheckScroller.innerHTML.length : 'SCROLLER NOT FOUND'}`);
        console.log(`🔍 Final recheck - Scroller content:`, recheckScroller ? recheckScroller.innerHTML : 'NO CONTENT');
      }, 50);
    } else {
      console.warn("⚠️ No scroller found in hyperlit-container after opening, setting content directly");
      container.innerHTML = content;
    }
  }, 50);
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
    
    console.log(`📦 Built unified content (${unifiedContent.length} chars):`, unifiedContent);
    
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
  // Check if element is a citation link
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
  
  // Also check if we're inside a citation element (for when clicking on highlighted citations)
  const parentCitation = element.closest('a.in-text-citation');
  if (parentCitation) {
    const href = parentCitation.getAttribute('href');
    if (href && href.startsWith('#')) {
      return {
        type: 'citation',
        element: parentCitation,
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
  let highlightElement = element;
  
  // If not provided, extract from element classes or parent mark element
  if (!highlightIds) {
    if (element.tagName === 'MARK') {
      highlightIds = Array.from(element.classList).filter(cls => cls.startsWith('HL_'));
    } else {
      // Check if this element is inside a mark with highlight classes
      const parentMark = element.closest('mark');
      if (parentMark) {
        highlightIds = Array.from(parentMark.classList).filter(cls => cls.startsWith('HL_'));
        highlightElement = parentMark;
      } else {
        // Check if there are mark elements inside this element
        const childMark = element.querySelector('mark');
        if (childMark) {
          highlightIds = Array.from(childMark.classList).filter(cls => cls.startsWith('HL_'));
          highlightElement = childMark;
        }
      }
    }
  }
  
  if (!highlightIds || highlightIds.length === 0) {
    return null;
  }
  
  return {
    type: 'highlight',
    element: highlightElement,
    highlightIds: highlightIds
  };
}

/**
 * Detect hypercite content
 */
async function detectHypercites(element) {
  let hyperciteElement = null;
  
  // Check for underlined elements with hypercite classes
  if (element.tagName === 'U' && (element.classList.contains('couple') || element.classList.contains('poly') || element.classList.contains('single'))) {
    hyperciteElement = element;
  } else {
    // Check if we're inside a hypercite element (for when clicking on highlighted hypercites)
    const parentHypercite = element.closest('u.couple, u.poly, u.single');
    if (parentHypercite) {
      hyperciteElement = parentHypercite;
    } else {
      // Check if there are hypercite elements inside this element
      const childHypercite = element.querySelector('u.couple, u.poly, u.single');
      if (childHypercite) {
        hyperciteElement = childHypercite;
      }
    }
  }
  
  if (hyperciteElement) {
    // Handle overlapping hypercites by extracting the actual IDs
    let hyperciteIds = [];
    if (hyperciteElement.hasAttribute('data-overlapping')) {
      hyperciteIds = hyperciteElement.getAttribute('data-overlapping').split(',');
    } else {
      hyperciteIds = [hyperciteElement.id];
    }
    
    return {
      type: 'hypercite',
      element: hyperciteElement,
      hyperciteId: hyperciteElement.id, // Keep the container ID for element reference
      hyperciteIds: hyperciteIds, // Add array of actual hypercite IDs
      relationshipStatus: hyperciteElement.classList.contains('couple') ? 'couple' : 
                          hyperciteElement.classList.contains('poly') ? 'poly' : 'single'
    };
  }
  
  return null;
}

/**
 * Build unified content HTML from detected content types
 */
async function buildUnifiedContent(contentTypes, newHighlightIds = []) {
  console.log("🔨 Building unified content for types:", contentTypes.map(ct => ct.type));
  
  // Fetch timestamps for each content type to sort chronologically
  const contentTypesWithTimestamps = await Promise.all(
    contentTypes.map(async (contentType) => {
      let timestamp = 0; // Default to 0 for items without timestamps (footnotes, citations)
      
      try {
        if (contentType.type === 'highlight') {
          // Get timestamp from highlight data
          const db = await openDatabase();
          const tx = db.transaction("hyperlights", "readonly");
          const store = tx.objectStore("hyperlights");
          const idx = store.index("hyperlight_id");
          
          if (contentType.highlightIds && contentType.highlightIds.length > 0) {
            const req = idx.get(contentType.highlightIds[0]);
            const result = await new Promise((resolve) => {
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => resolve(null);
            });
            if (result && result.time_since) {
              timestamp = result.time_since;
            }
          }
        } else if (contentType.type === 'hypercite') {
          // Get timestamp from hypercite data
          const db = await openDatabase();
          const tx = db.transaction("hypercites", "readonly");
          const store = tx.objectStore("hypercites");
          const index = store.index("hyperciteId");
          
          const req = index.get(contentType.hyperciteId);
          const result = await new Promise((resolve) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
          });
          if (result && result.time_since) {
            timestamp = result.time_since;
          }
        }
        // Footnotes and citations don't have creation timestamps, so they stay at 0
      } catch (error) {
        console.warn(`Error getting timestamp for ${contentType.type}:`, error);
      }
      
      return { ...contentType, timestamp };
    })
  );
  
  // Sort by timestamp (oldest first, with 0 timestamps appearing first)
  contentTypesWithTimestamps.sort((a, b) => a.timestamp - b.timestamp);
  
  console.log("🕐 Content types sorted by timestamp:", contentTypesWithTimestamps.map(ct => ({ type: ct.type, timestamp: ct.timestamp })));
  
  let contentHtml = '';
  
  // Process each content type in chronological order
  for (const contentType of contentTypesWithTimestamps) {
    console.log(`🔨 Processing ${contentType.type} content...`);
    
    switch (contentType.type) {
      case 'footnote':
        const footnoteHtml = await buildFootnoteContent(contentType);
        if (footnoteHtml) {
          console.log(`✅ Added footnote content (${footnoteHtml.length} chars)`);
          contentHtml += footnoteHtml;
        }
        break;
        
      case 'citation':
        const citationHtml = await buildCitationContent(contentType);
        if (citationHtml) {
          console.log(`✅ Added citation content (${citationHtml.length} chars)`);
          contentHtml += citationHtml;
        }
        break;
        
      case 'highlight':
        const highlightHtml = await buildHighlightContent(contentType, newHighlightIds);
        if (highlightHtml) {
          console.log(`✅ Added highlight content (${highlightHtml.length} chars)`);
          contentHtml += highlightHtml;
        } else {
          console.warn("⚠️ No highlight content generated");
        }
        break;
        
      case 'hypercite':
        const hyperciteHtml = await buildHyperciteContent(contentType);
        if (hyperciteHtml) {
          console.log(`✅ Added hypercite content (${hyperciteHtml.length} chars)`);
          contentHtml += hyperciteHtml;
        } else {
          console.warn("⚠️ No hypercite content generated");
        }
        break;
    }
  }
  
  if (!contentHtml) {
    console.error("❌ No content was generated for any content type!");
    contentHtml = '<div class="error">No content available</div>';
  }
  
  console.log(`📦 Final content HTML (${contentHtml.length} chars):`, contentHtml);
  
  // Return just the content, not the full structure
  // The container already has the scroller, masks, etc.
  return contentHtml;
}

/**
 * Build footnote content section
 */
async function buildFootnoteContent(contentType) {
  try {
    const { elementId, fnCountId } = contentType;
    
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
      // Remove or replace block-level tags to keep content inline
      const inlineContent = result.content
        .replace(/<\/?p[^>]*>/g, '') // Remove <p> tags
        .replace(/<\/?div[^>]*>/g, ''); // Remove <div> tags
      
      return `
        <div class="footnotes-section">
          <div class="footnote-content">
            <div class="footnote-text" style="display: flex; align-items: flex-start;"><sup style="margin-right: 1em; flex-shrink: 0;">${fnCountId}</sup><span style="flex: 1;">${inlineContent}</span></div>
          </div>
          <hr style="margin: 2em 0; opacity: 0.5;">
        </div>`;
    } else {
      return `
        <div class="footnotes-section">
          <sup>${fnCountId}</sup>
          <div class="error">Footnote not found: ${footnoteId}</div>
          <hr>
        </div>`;
    }
  } catch (error) {
    console.error('Error building footnote content:', error);
    return `
      <div class="footnotes-section">
        <sup>${fnCountId || '?'}</sup>
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
          <div class="citation-content">
            <div class="citation-text">${result.content}</div>
          </div>
          <hr style="margin: 2em 0; opacity: 0.5;">
        </div>`;
    } else {
      return `
        <div class="citations-section">
          <div class="error">Reference not found: ${referenceId}</div>
          <hr style="margin: 2em 0; opacity: 0.5;">
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
    console.log(`🎨 Building highlight content for IDs:`, highlightIds);
    
    const currentUserId = await getCurrentUserId();
    console.log(`👤 Current user ID:`, currentUserId);
    
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

    let html = `<div class="highlights-section">\n<br>\n<h1>Hyperlights</h1>\n<br>\n`;

    let firstUserAnnotation = null;

    validResults.forEach((h, index) => {
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
      
      // Add hr between highlights (but not after the last one)
      if (index < validResults.length - 1) {
        html += `  <hr style="margin: 1em 0;">\n`;
      }

      // Track first user annotation for cursor placement
      if (isEditable && !firstUserAnnotation) {
        firstUserAnnotation = h.hyperlight_id;
      }
    });
    
    html += `<hr style="margin: 1em 0;">\n</div>\n`;
    
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
    const { hyperciteId, hyperciteIds, relationshipStatus } = contentType;
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
    
    const db = await openDatabase();
    const tx = db.transaction("hypercites", "readonly");
    const store = tx.objectStore("hypercites");
    const index = store.index("hyperciteId");

    // Use the hyperciteIds array if available, otherwise fall back to single hyperciteId
    const idsToProcess = hyperciteIds || [hyperciteId];
    const hyperciteDataArray = [];
    
    // Fetch data for all hypercite IDs
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

    if (hyperciteDataArray.length === 0) {
      return `
        <div class="hypercites-section">
          <b>Hypercite</b>
          <div class="error">Hypercite data not found</div>
          <hr>
        </div>`;
    }


    let html = `<div class="hypercites-section">\n<h1>Cited By</h1>\n`;

    
    // Collect all citedIN links from all hypercites
    const allCitedINLinks = [];
    for (const hyperciteData of hyperciteDataArray) {
      if (Array.isArray(hyperciteData.citedIN) && hyperciteData.citedIN.length > 0) {
        allCitedINLinks.push(...hyperciteData.citedIN);
      }
    }
    
    // Remove duplicates
    const uniqueCitedINLinks = [...new Set(allCitedINLinks)];
    
    if (uniqueCitedINLinks.length > 0) {
      const linksHTML = await Promise.all(
        uniqueCitedINLinks.map(async (citationID) => {
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
                  `<blockquote>${citationText} <a href="${citationID}" class="citation-link"><span class="open-icon">↗</span></a></blockquote>`
                );
              } else {
                // Fallback: try to fetch from server
                const serverLibraryData = await fetchLibraryFromServer(bookID);
                if (serverLibraryData && serverLibraryData.bibtex) {
                  const formattedCitation = await formatBibtexToCitation(serverLibraryData.bibtex);
                  const citationText = isHyperlightURL 
                    ? `a <span id="citedInHyperlight">Hyperlight</span> in ${formattedCitation}` 
                    : formattedCitation;

                  resolve(
                    `<blockquote>${citationText} <a href="${citationID}" class="citation-link"><span class="open-icon">↗</span></a></blockquote>`
                  );
                } else {
                  resolve(`<a href="${citationID}" class="citation-link">${citationID}</a>`);
                }
              }
            };

            libraryRequest.onerror = async () => {
              // Fallback: try to fetch from server
              const serverLibraryData = await fetchLibraryFromServer(bookID);
              if (serverLibraryData && serverLibraryData.bibtex) {
                const formattedCitation = await formatBibtexToCitation(serverLibraryData.bibtex);
                const citationText = isHyperlightURL 
                  ? `a <span id="citedInHyperlight">Hyperlight</span> in ${formattedCitation}` 
                  : formattedCitation;

                resolve(
                  `<blockquote>${citationText} <a href="${citationID}" class="citation-link"><span class="open-icon">↗</span></a></blockquote>`
                );
              } else {
                resolve(`<a href="${citationID}" class="citation-link">${citationID}</a>`);
              }
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
        <b>Hypercite:</b>
        <div class="error">Error loading hypercite data</div>
        <hr>
      </div>`;
  }
}

/**
 * Fetch library record from server as fallback
 */
async function fetchLibraryFromServer(bookId) {
  try {
    const response = await fetch(`/api/database-to-indexeddb/books/${bookId}/library`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content'),
      },
      credentials: 'include'
    });
    
    if (!response.ok) {
      throw new Error(`Server request failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    // The API returns {success: true, library: {...}, book_id: ...}
    if (data && data.success && data.library) {
      if (data.library.bibtex) {
        return data.library;
      } else if (data.library.title || data.library.author) {
        // Create basic bibtex from available fields
        const basicBibtex = `@misc{${bookId},
  author = {${data.library.author || 'Unknown'}},
  title = {${data.library.title || 'Untitled'}},
  year = {${new Date().getFullYear()}},
}`;
        return {
          ...data.library,
          bibtex: basicBibtex
        };
      }
    }
    
    return null;
  } catch (error) {
    console.error('Failed to fetch library record from server:', error);
    return null;
  }
}

/**
 * Handle post-open actions like cursor placement
 */
async function handlePostOpenActions(contentTypes, newHighlightIds = []) {
  // Handle highlight-specific post-open actions
  const highlightType = contentTypes.find(ct => ct.type === 'highlight');
  if (highlightType) {
    try {
      // Import the required functions
      const { attachAnnotationListener } = await import('./annotation-saver.js');
      const { addHighlightContainerPasteListener } = await import('./hyperLightsListener.js');
      // Note: attachPlaceholderBehavior might not exist yet, so we'll skip it for now
      
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
          // Delay listener attachment to ensure DOM is ready
          setTimeout(() => {
            attachAnnotationListener(highlight.hyperlight_id);
            addHighlightContainerPasteListener(highlight.hyperlight_id);
            // Skip attachPlaceholderBehavior for now since it might not exist
          }, 100);

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
    
    } catch (error) {
      console.error('Error in highlight post-actions:', error);
    }

  }
}

// Export backward compatibility functions
export { hyperlitManager };
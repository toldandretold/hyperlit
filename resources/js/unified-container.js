// unified-container.js - Unified system for all hyperlit content types
import { book } from "./app.js";
import { openDatabase } from "./cache-indexedDB.js";
import { ContainerManager } from "./container-manager.js";
import { formatBibtexToCitation } from "./bibtexProcessor.js";
import { getCurrentUserId } from "./auth.js";

// Create the unified container manager
let hyperlitManager = null;

// Debounce mechanism to prevent duplicate calls
let isProcessingClick = false;


export function initializeHyperlitManager() {
  // Ensure DOM is ready before initializing
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeHyperlitManagerInternal);
    return;
  }
  initializeHyperlitManagerInternal();
}

function initializeHyperlitManagerInternal() {

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

export function openHyperlitContainer(content, isBackNavigation = false) {
  if (!hyperlitManager) {
    initializeHyperlitManager();
  }
  
  // Reset the processing flag when opening a new container
  // This prevents navigation clicks from being blocked by previous operations
  isProcessingClick = false;
  console.log("🔄 Reset isProcessingClick flag for new container");
  
  // Get the container (should exist after initialization)
  const container = document.getElementById("hyperlit-container");
  if (!container) {
    console.error("❌ hyperlit-container not found after initialization!");
    return;
  }
  

  // Clear any existing content first to prevent duplicates
  const existingScroller = container.querySelector('.scroller');
  if (existingScroller) {
    existingScroller.innerHTML = '';
  }

  // Open the container using the manager FIRST
  console.log("📂 Opening container with manager first...");
  
  // Set the back navigation flag on the manager
  hyperlitManager.isBackNavigation = isBackNavigation;
  
  hyperlitManager.openContainer();
  
  // THEN set the content after the container is opened
  setTimeout(() => {
    const scroller = container.querySelector('.scroller');
    if (scroller) {
      console.log(`📝 Setting content in scroller AFTER opening (${content.length} chars)`);

      // Clear content again just before setting to ensure no duplicates
      scroller.innerHTML = '';
      scroller.innerHTML = content;
      console.log(`✅ Content set after opening. Scroller innerHTML length: ${scroller.innerHTML.length}`);
    } else {
      console.warn("⚠️ No scroller found in hyperlit-container after opening, setting content directly");
      // Clear and set content directly
      container.innerHTML = '';
      container.innerHTML = content;
    }
  }, 50);
}

export function closeHyperlitContainer() {
  if (!hyperlitManager) {
    try {
      initializeHyperlitManager();
    } catch (error) {
      console.warn('Could not initialize hyperlitManager for closing:', error);
      return; // Exit early if initialization fails
    }
  }
  
  if (hyperlitManager && hyperlitManager.closeContainer) {
    try {
      // Clean up URL hash and history state when closing container
      const currentUrl = window.location;
      if (currentUrl.hash && (currentUrl.hash.startsWith('#HL_') || currentUrl.hash.startsWith('#hypercite_') || 
                             currentUrl.hash.startsWith('#footnote_') || currentUrl.hash.startsWith('#citation_'))) {
        // Remove hyperlit-related hash from URL
        const cleanUrl = `${currentUrl.pathname}${currentUrl.search}`;
        console.log('🔗 Cleaning up hyperlit hash from URL:', currentUrl.hash, '→', cleanUrl);
        
        // Push new clean state to history
        const currentState = history.state || {};
        const newState = {
          ...currentState,
          hyperlitContainer: null // Clear container state
        };
        history.pushState(newState, '', cleanUrl);
      }
      
      hyperlitManager.closeContainer();
    } catch (error) {
      console.warn('Could not close hyperlit container:', error);
    }
  }
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
export async function handleUnifiedContentClick(element, highlightIds = null, newHighlightIds = [], skipUrlUpdate = false, isBackNavigation = false, directHyperciteId = null) {
  const logElement = element ? (element.id || element.tagName) : (directHyperciteId || 'No element');
  console.log("🎯 handleUnifiedContentClick called with:", { element: logElement, isBackNavigation, directHyperciteId, isProcessingClick });

  if (isProcessingClick) {
    console.log("🚫 Click already being processed, ignoring duplicate. Current flag state:", isProcessingClick);
    console.log("🚫 Call stack:", new Error().stack);
    return;
  }
  console.log("✅ Setting isProcessingClick to true");
  isProcessingClick = true;

  try {
    let contentTypes = [];

    // If this is a history navigation, we have no element, only an ID.
    // We can skip the broad detection and go straight to finding the content.
    if (!element && directHyperciteId) {
        console.log(`🎯 History navigation detected for: ${directHyperciteId}. Detecting content directly.`);
        
        // Determine content type from the ID and detect accordingly
        if (directHyperciteId.startsWith('hypercite_')) {
          const hyperciteData = await detectHypercites(null, directHyperciteId);
          if (hyperciteData) {
            contentTypes.push(hyperciteData);
          }
        } else if (directHyperciteId.startsWith('HL_')) {
          const highlightData = await detectHighlights(null, [directHyperciteId]);
          if (highlightData) {
            contentTypes.push(highlightData);
          }
        } else if (directHyperciteId.startsWith('footnote_')) {
          const footnoteId = directHyperciteId.replace('footnote_', '');
          const footnoteData = {
            type: 'footnote',
            element: null,
            elementId: footnoteId,
            fnCountId: null // Will be determined during content building
          };
          contentTypes.push(footnoteData);
        } else if (directHyperciteId.startsWith('citation_')) {
          const referenceId = directHyperciteId.replace('citation_', '');
          const citationData = {
            type: 'citation',
            element: null,
            referenceId: referenceId
          };
          contentTypes.push(citationData);
        }
    } else if (element) {
        // This is a standard click, run the full detection.
        console.log("🎯 Click navigation detected. Running full content detection.");
        contentTypes = await detectContentTypes(element, highlightIds, directHyperciteId);
    } else {
        console.warn("handleUnifiedContentClick called with no element or direct ID. Aborting.");
        isProcessingClick = false;
        return;
    }
    
    if (contentTypes.length === 0) {
      console.log("No hyperlit content detected.");
      isProcessingClick = false;
      return;
    }
    
    console.log(`📊 Detected content types: ${contentTypes.map(c => c.type).join(', ')}`);
    
    // Store container state in history for back button support
    if (!skipUrlUpdate && !isBackNavigation) {
      const containerState = {
        contentTypes: contentTypes.map(ct => ({
          type: ct.type,
          hyperciteId: ct.hyperciteId,
          highlightIds: ct.highlightIds,
          fnCountId: ct.fnCountId,
          elementId: ct.elementId,
          referenceId: ct.referenceId,
          relationshipStatus: ct.relationshipStatus
        })),
        newHighlightIds,
        timestamp: Date.now()
      };
      
      // Store in current history state for potential restoration
      const currentState = history.state || {};
      const newState = {
        ...currentState,
        hyperlitContainer: containerState
      };
      
      console.log('📊 Storing hyperlit container state in history:', containerState);
      
      // Determine if we should update URL (only for single content types)
      const urlHash = determineSingleContentHash(contentTypes);
      if (urlHash) {
        // Check if we already have a specific hypercite target that should be preserved
        const currentHash = window.location.hash.substring(1); // Remove #
        const hasHyperciteTarget = currentHash && currentHash.startsWith('hypercite_');
        
        if (hasHyperciteTarget && contentTypes[0].type === 'highlight') {
          // We're opening a highlight container but there's a specific hypercite target
          // Preserve the original hypercite hash for in-container scrolling
          console.log(`📊 Preserving hypercite target in URL: #${currentHash}`);
          history.replaceState(newState, '');
        } else {
          const newUrl = `${window.location.pathname}${window.location.search}#${urlHash}`;
          console.log(`📊 Updating URL for single content: ${newUrl}`);
          history.pushState(newState, '', newUrl);
        }
      } else {
        // Multiple content types or no hash needed - keep current URL
        console.log('📊 Multiple content types detected - keeping current URL');
        history.replaceState(newState, '');
      }
    }
    
    // Build unified content
    const unifiedContent = await buildUnifiedContent(contentTypes, newHighlightIds);
    
    console.log(`📦 Built unified content (${unifiedContent.length} chars)`);
    
    // Open the unified container
    openHyperlitContainer(unifiedContent, isBackNavigation);
    
    // Handle any post-open actions (like cursor placement for editable content)
    await handlePostOpenActions(contentTypes, newHighlightIds);
    
  } catch (error) {
    console.error("❌ Error in unified content handler:", error);
  } finally {
    // Reset the processing flag after a short delay
    setTimeout(() => {
      console.log("🔄 Resetting isProcessingClick flag");
      isProcessingClick = false;
    }, 500);

  }
}

/**
 * Detect all content types present on an element
 * @param {HTMLElement} element - The element to analyze
 * @param {Array} providedHighlightIds - Optional highlight IDs if already known
 * @returns {Array} Array of content type objects
 */
async function detectContentTypes(element, providedHighlightIds = null, directHyperciteId = null) {
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
  const hyperciteData = await detectHypercites(element, directHyperciteId);
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
async function detectHypercites(element, directHyperciteId = null) {
  let hyperciteElement = null;
  let hyperciteIdFromElement = null;
  let relationshipStatus = 'single'; // Default to single

  if (directHyperciteId) {
    hyperciteIdFromElement = directHyperciteId;
    hyperciteElement = document.getElementById(directHyperciteId); // Try to find it
  } else {
    // Existing logic to find hypercite element from click
    if (element.tagName === 'U' && (element.classList.contains('couple') || element.classList.contains('poly') || element.classList.contains('single'))) {
      hyperciteElement = element;
    } else {
      const parentHypercite = element.closest('u.couple, u.poly, u.single');
      if (parentHypercite) {
        hyperciteElement = parentHypercite;
      } else {
        const childHypercite = element.querySelector('u.couple, u.poly, u.single');
        if (childHypercite) {
          hyperciteElement = childHypercite;
        }
      }
    }
    if (hyperciteElement) {
      hyperciteIdFromElement = hyperciteElement.id;
    }
  }

  if (hyperciteIdFromElement) {
    let hyperciteIds = [];
    let primaryHyperciteId = hyperciteIdFromElement;
    
    // Check if this is an overlapping hypercite
    if (hyperciteElement && hyperciteElement.id === 'hypercite_overlapping' && hyperciteElement.hasAttribute('data-overlapping')) {
      // Extract actual hypercite IDs from data-overlapping attribute
      const overlappingData = hyperciteElement.getAttribute('data-overlapping');
      hyperciteIds = overlappingData.split(',').map(id => id.trim());
      
      // For overlapping hypercites, we need to determine which hypercite to use as primary
      // Use the first one as primary for data-content-id purposes
      primaryHyperciteId = hyperciteIds[0];
      
      console.log(`🔄 Detected overlapping hypercite with IDs: ${JSON.stringify(hyperciteIds)}, using primary: ${primaryHyperciteId}`);
    } else if (hyperciteElement && hyperciteElement.hasAttribute('data-overlapping')) {
      // Regular overlapping case
      hyperciteIds = hyperciteElement.getAttribute('data-overlapping').split(',').map(id => id.trim());
      primaryHyperciteId = hyperciteIds[0];
    } else {
      // Single hypercite
      hyperciteIds = [hyperciteIdFromElement];
      primaryHyperciteId = hyperciteIdFromElement;
    }

    // Determine relationshipStatus:
    // 1. From DOM element classes if available
    if (hyperciteElement) {
      if (hyperciteElement.classList.contains('couple')) {
        relationshipStatus = 'couple';
      } else if (hyperciteElement.classList.contains('poly')) {
        relationshipStatus = 'poly';
      } else if (hyperciteElement.classList.contains('single')) {
        relationshipStatus = 'single';
      }
    } 
    // 2. Fallback to IndexedDB if element not found or no class found on element
    if (!hyperciteElement || (relationshipStatus === 'single' && !hyperciteElement.classList.contains('single'))) { // Only fetch from DB if element not found OR if element is 'single' but might be more
      const db = await openDatabase();
      const tx = db.transaction("hypercites", "readonly");
      const store = tx.objectStore("hypercites");
      const index = store.index("hyperciteId");
      const req = index.get(primaryHyperciteId);
      const result = await new Promise((resolve) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
      if (result && result.relationshipStatus) {
        relationshipStatus = result.relationshipStatus;
      }
    }
    
    return {
      type: 'hypercite',
      element: hyperciteElement, // May be null if directHyperciteId was used and element not found
      hyperciteId: primaryHyperciteId, // Use primary hypercite ID instead of element ID
      hyperciteIds: hyperciteIds,
      relationshipStatus: relationshipStatus
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
  
  // Sort by content type priority: footnotes/citations first, then hypercites, then highlights
  const typePriority = {
    'footnote': 1,
    'citation': 2, 
    'hypercite': 3,
    'highlight': 4
  };
  
  contentTypesWithTimestamps.sort((a, b) => {
    const priorityA = typePriority[a.type] || 999;
    const priorityB = typePriority[b.type] || 999;
    
    // First sort by type priority
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    
    // Within same type, sort by timestamp (oldest first)
    return a.timestamp - b.timestamp;
  });
  
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
    const { elementId, fnCountId, element } = contentType;
    
    // Get the actual footnoteId from the link's href, not the elementId
    let footnoteId = null;
    
    // Look for the footnote link inside the sup element
    const footnoteLink = element.querySelector('a.footnote-ref');
    if (footnoteLink && footnoteLink.href) {
      // Extract footnoteId from href like "#test555gdzzdddcsxkkFn1758412345001"
      footnoteId = footnoteLink.href.split('#')[1];
      console.log(`🔍 Found footnote link with href: ${footnoteLink.href}, extracted footnoteId: ${footnoteId}`);
    }
    
    // Fallback: try the old method if no link found
    if (!footnoteId) {
      footnoteId = elementId;
      if (footnoteId && footnoteId.includes('ref')) {
        footnoteId = footnoteId.replace('ref', '');
      }
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
        <div class="footnotes-section" data-content-id="${footnoteId}">
          <div class="footnote-content">
            <div class="footnote-text" style="display: flex; align-items: flex-start;"><sup style="margin-right: 1em; flex-shrink: 0;">${fnCountId}</sup><span style="flex: 1;">${inlineContent}</span></div>
          </div>
          <hr style="margin: 2em 0; opacity: 0.5;">
        </div>`;
    } else {
      return `
        <div class="footnotes-section" data-content-id="${footnoteId}">
          <sup>${fnCountId}</sup>
          <div class="error">Footnote not found: ${footnoteId}</div>
          <hr>
        </div>`;
    }
  } catch (error) {
    console.error('Error building footnote content:', error);
    return `
      <div class="footnotes-section" data-content-id="${footnoteId || 'unknown'}">
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
        <div class="citations-section" data-content-id="${referenceId}">
          <div class="citation-content">
            <div class="citation-text">${result.content}</div>
          </div>
          <hr style="margin: 2em 0; opacity: 0.5;">
        </div>`;
    } else {
      return `
        <div class="citations-section" data-content-id="${referenceId}">
          <div class="error">Reference not found: ${referenceId}</div>
          <hr style="margin: 2em 0; opacity: 0.5;">
        </div>`;
    }
  } catch (error) {
    console.error('Error building citation content:', error);
    return `
      <div class="citations-section" data-content-id="error">
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


    // Check if current user can edit any of the books these highlights belong to
    const { canUserEditBook } = await import('./auth.js');
    const bookPermissions = new Map();
    
    // Get unique book IDs and check permissions
    const uniqueBooks = [...new Set(validResults.map(h => h.book))];
    for (const bookId of uniqueBooks) {
      const canEdit = await canUserEditBook(bookId);
      bookPermissions.set(bookId, canEdit);
    }


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

/**
 * Build hypercite content section
 */
async function buildHyperciteContent(contentType) {
  try {
    const { hyperciteId, hyperciteIds, relationshipStatus } = contentType;
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

    let html = `<div class="hypercites-section">
<h1>Cited By</h1>
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
      const linksHTML = await Promise.all(
        uniqueCitedINLinks.map(async (citationItem) => {
          const { link: citationID, hyperciteId } = citationItem;
          
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
                  `<blockquote>${citationText} <a href="${citationID}" class="citation-link" data-content-id="${hyperciteId}"><span class="open-icon">↗</span></a></blockquote>`
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
                    `<blockquote>${citationText} <a href="${citationID}" class="citation-link" data-content-id="${hyperciteId}"><span class="open-icon">↗</span></a></blockquote>`
                  );
                } else {
                  resolve(`<a href="${citationID}" class="citation-link" data-content-id="${hyperciteId}">${citationID}</a>`);
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
                  `<blockquote>${citationText} <a href="${citationID}" class="citation-link" data-content-id="${hyperciteId}"><span class="open-icon">↗</span></a></blockquote>`
                );
              } else {
                resolve(`<a href="${citationID}" class="citation-link" data-content-id="${hyperciteId}">${citationID}</a>`);
              }
            };
          });
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
 * Determine URL hash for single content types
 * Returns null for multiple content types (overlapping content)
 */
function determineSingleContentHash(contentTypes) {
  if (contentTypes.length !== 1) {
    return null; // Multiple content types - don't update URL
  }
  
  const contentType = contentTypes[0];
  
  switch (contentType.type) {
    case 'hypercite':
      if (contentType.hyperciteId) {
        // Remove hypercite_ prefix if present, then add it back for consistency
        const cleanId = contentType.hyperciteId.replace(/^hypercite_/, '');
        return `hypercite_${cleanId}`;
      }
      break;
      
    case 'highlight':
      if (contentType.highlightIds && contentType.highlightIds.length === 1) {
        return contentType.highlightIds[0]; // Already has HL_ prefix
      }
      break;
      
    case 'footnote':
      if (contentType.elementId) {
        return `footnote_${contentType.elementId}`;
      }
      break;
      
    case 'citation':
      if (contentType.referenceId) {
        return `citation_${contentType.referenceId}`;
      }
      break;
  }
  
  return null;
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
      const { attachPlaceholderBehavior } = await import('./hyperLights.js');

      
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
        const isUserHighlight = highlight.creator ? highlight.creator === currentUserId : (!highlight.creator && highlight.creator_token === currentUserId);
        const isNewlyCreated = newHighlightIds.includes(highlight.hyperlight_id);
        const isEditable = isUserHighlight || isNewlyCreated;

        if (isEditable) {
          // Delay listener attachment to ensure DOM is ready
          setTimeout(() => {
            attachAnnotationListener(highlight.hyperlight_id);
            addHighlightContainerPasteListener(highlight.hyperlight_id);
            attachPlaceholderBehavior(highlight.hyperlight_id);
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
    

    // Attach delete button listeners
    setTimeout(() => {
      const deleteButtons = document.querySelectorAll('.delete-highlight-btn');
      deleteButtons.forEach(button => {
        button.addEventListener('click', handleHighlightDelete);
      });
    }, 200);
    
    } catch (error) {
      console.error('Error in highlight post-actions:', error);
    }
  }
  
  // Always attach data-content-id link listeners for URL updates
  setTimeout(() => {
    attachDataContentIdLinkListeners();
  }, 100);
}

/**
 * Attach listeners to all links inside hyperlit-container for smart URL updates
 */
function attachDataContentIdLinkListeners() {
  const allLinks = document.querySelectorAll('#hyperlit-container a[href]');
  
  console.log(`🔗 Found ${allLinks.length} links in hyperlit container for smart URL updates`);
  
  allLinks.forEach(link => {
    // Skip if already processed to prevent duplicate listeners
    if (link._smartContentListenerAttached) {
      console.log(`🔗 Skipping link - already has smart listener:`, link.href);
      return;
    }
    
    // Remove existing listener if present
    if (link._smartContentListener) {
      link.removeEventListener('click', link._smartContentListener);
    }
    
    // Create new listener
    link._smartContentListener = async function(event) {
      console.log(`🔗 Smart content listener triggered for:`, this.href, `isProcessingClick: ${isProcessingClick}`);
      const contextId = findClosestContentId(this);
      if (contextId) {
        console.log(`🔗 Link clicked in context: ${contextId} - checking if same-book navigation`);
        
        try {
          // Import navigation logic to check if this is same-book navigation
          const { LinkNavigationHandler } = await import('./navigation/LinkNavigationHandler.js');
          const { book } = await import('./app.js');
          
          const linkUrl = new URL(this.href, window.location.origin);
          const currentUrl = new URL(window.location.href);
          const currentBookPath = `/${book}`;
          
          const isSameBook = LinkNavigationHandler.isSameBookNavigation(linkUrl, currentUrl, currentBookPath);
          
          if (isSameBook) {
            console.log(`🔗 Same-book navigation detected - handling directly without reload`);
            event.preventDefault();
            event.stopPropagation();
            
            // Save the context we're navigating FROM in the current history state
            const currentState = history.state || {};
            const newState = {
              ...currentState,
              hyperlitContainer: {
                contentTypes: [{ 
                  type: contextId.startsWith('HL_') ? 'highlight' : 
                        contextId.startsWith('hypercite_') ? 'hypercite' :
                        contextId.startsWith('footnote_') ? 'footnote' : 'citation',
                  [contextId.startsWith('HL_') ? 'highlightIds' : 
                    contextId.startsWith('hypercite_') ? 'hyperciteId' :
                    contextId.startsWith('footnote_') ? 'elementId' : 'referenceId']: 
                    contextId.startsWith('HL_') ? [contextId] : contextId
                }],
                timestamp: Date.now()
              }
            };
            
            // Replace current state to preserve context for back button
            history.replaceState(newState, '');
            
            // Close container and handle same-book navigation directly
            closeHyperlitContainer();
            
            // Handle the same-book navigation using LinkNavigationHandler
            await LinkNavigationHandler.handleSameBookNavigation(this, linkUrl);
            
            return; // Don't let the link continue to global handler
          } else {
            console.log(`🔗 Cross-book navigation detected - saving state and allowing normal flow`);
            
            // Save context for back button
            const currentState = history.state || {};
            const newState = {
              ...currentState,
              hyperlitContainer: {
                contentTypes: [{ 
                  type: contextId.startsWith('HL_') ? 'highlight' : 
                        contextId.startsWith('hypercite_') ? 'hypercite' :
                        contextId.startsWith('footnote_') ? 'footnote' : 'citation',
                  [contextId.startsWith('HL_') ? 'highlightIds' : 
                    contextId.startsWith('hypercite_') ? 'hyperciteId' :
                    contextId.startsWith('footnote_') ? 'elementId' : 'referenceId']: 
                    contextId.startsWith('HL_') ? [contextId] : contextId
                }],
                timestamp: Date.now()
              }
            };
            
            history.replaceState(newState, '');
            closeHyperlitContainer();
            
            // Let the link continue to global handler for cross-book navigation
          }
        } catch (error) {
          console.error('🔗 Error in smart content listener:', error);
          // Fallback to original behavior
          closeHyperlitContainer();
        }
      } else {
        console.log(`🔗 No context ID found for link:`, this.href);
      }
      
      // For cross-book navigation, don't prevent default - let normal flow continue
    };
    
    // Attach the listener
    link.addEventListener('click', link._smartContentListener);
    
    // Mark as processed
    link._smartContentListenerAttached = true;
    console.log(`🔗 Attached smart listener to:`, link.href);
  });
}

/**
 * Find the closest data-content-id by traversing up the DOM
 */
function findClosestContentId(element) {
  // Special case: if this is a hypercite link with an ID, use that as the content ID
  if (element.id && element.id.startsWith('hypercite_')) {
    console.log(`🎯 Found hypercite link with ID: ${element.id}`);
    return element.id;
  }
  
  // First check if the link itself has data-content-id
  if (element.hasAttribute('data-content-id')) {
    return element.getAttribute('data-content-id');
  }
  
  // Then traverse up to find the closest parent with data-content-id
  let current = element.parentElement;
  while (current && current !== document.body) {
    if (current.hasAttribute('data-content-id')) {
      const contentId = current.getAttribute('data-content-id');
      console.log(`🎯 Found closest context: ${contentId} on element:`, current.className || current.tagName);
      return contentId;
    }
    current = current.parentElement;
  }
  
  console.warn('🚫 No data-content-id found for link:', element.href);
  return null;
}

/**
 * Determine hash from content ID
 */
function determineHashFromContentId(contentId) {
  // Handle different content ID patterns
  if (contentId.startsWith('hypercite_')) {
    return contentId; // Already in correct format
  } else if (contentId.startsWith('HL_')) {
    return contentId; // Already in correct format  
  } else if (contentId.startsWith('footnote_')) {
    return contentId; // Already in correct format
  } else if (contentId.startsWith('citation_')) {
    return contentId; // Already in correct format
  } else {
    // Plain ID - try to determine type by context or assume citation
    return `citation_${contentId}`;
  }
}

/**
 * Handle highlight delete button click
 */
async function handleHighlightDelete(event) {
  event.preventDefault();
  event.stopPropagation();
  
  const button = event.currentTarget;
  const highlightId = button.getAttribute('data-highlight-id');
  const action = button.getAttribute('data-action'); // 'delete' or 'hide'
  
  if (!highlightId) {
    console.error('No highlight ID found for delete action');
    return;
  }
  
  // Confirm delete action
  const actionText = action === 'delete' ? 'delete this highlight' : 'hide this highlight';
  if (!confirm(`Are you sure you want to ${actionText}?`)) {
    return;
  }
  
  try {
    console.log(`🗑️ ${action === 'delete' ? 'Deleting' : 'Hiding'} highlight: ${highlightId}`);
    
    // Remove the highlight section from the container UI immediately
    const highlightSection = document.querySelector(`#hyperlit-container .author[id="${highlightId}"]`);
    let highlightElements = [];
    
    if (highlightSection) {
      // Collect all elements belonging to this highlight (author, blockquote, annotation, hr)
      let currentElement = highlightSection;
      while (currentElement) {
        highlightElements.push(currentElement);
        const nextElement = currentElement.nextElementSibling;
        
        // Stop when we hit another author div or reach the end
        if (nextElement && nextElement.classList.contains('author') && nextElement.id !== highlightId) {
          break;
        }
        if (nextElement && nextElement.tagName === 'HR') {
          highlightElements.push(nextElement);
          break;
        }
        if (!nextElement) {
          break;
        }
        currentElement = nextElement;
      }
      
      // Remove all collected elements
      highlightElements.forEach(el => el.remove());
    }
    
    if (action === 'delete') {
      // Full delete - import delete functionality from hyperLights.js
      const { deleteHighlightById } = await import('./hyperLights.js');
      await deleteHighlightById(highlightId);
    } else if (action === 'hide') {
      // Hide - same as delete but sync as hide operation instead of delete
      const { hideHighlightById } = await import('./hyperLights.js');
      await hideHighlightById(highlightId);
    } else {
      console.log('Unknown action:', action);
    }
    
    // Check if there are any remaining highlights in the container
    const remainingHighlights = document.querySelectorAll('#hyperlit-container .author[id^="HL_"]');
    
    if (remainingHighlights.length === 0) {
      // No more highlights - close the container
      closeHyperlitContainer();
    } else {
      // Update the container height if needed
      console.log(`✅ Highlight removed. ${remainingHighlights.length} highlights remaining.`);
    }
    
  } catch (error) {
    console.error(`Error ${action === 'delete' ? 'deleting' : 'hiding'} highlight:`, error);
    alert(`Failed to ${action} highlight. Please try again.`);
    
    // On error, we should refresh the container to restore the deleted UI element
    // This is a fallback in case the backend operation failed
    location.reload();
  }
}

/**
 * Hide a highlight by setting the hidden flag in the database
 */
async function hideHighlight(highlightId) {
  try {
    console.log(`🙈 Hiding highlight: ${highlightId}`);
    
    // Get highlight data to determine book
    const { openDatabase } = await import('./cache-indexedDB.js');
    const db = await openDatabase();
    const tx = db.transaction("hyperlights", "readonly");
    const store = tx.objectStore("hyperlights");
    const idx = store.index("hyperlight_id");
    
    const highlightData = await new Promise((resolve, reject) => {
      const request = idx.get(highlightId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    
    if (!highlightData) {
      throw new Error(`Highlight not found: ${highlightId}`);
    }
    
    const bookId = highlightData.book;
    console.log(`📚 Hiding highlight in book: ${bookId}`);
    
    // Send hide request to server
    const response = await fetch('/api/db/hyperlights/hide', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')
      },
      body: JSON.stringify({
        data: [{
          book: bookId,
          hyperlight_id: highlightId
        }]
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const result = await response.json();
    if (!result.success) {
      throw new Error(result.message || 'Hide operation failed');
    }
    
    console.log(`✅ Successfully hidden highlight: ${highlightId}`);
    
    // Note: We don't need to remove from IndexedDB for hide operation
    // The highlight should remain in IndexedDB but be filtered out during rendering
    
  } catch (error) {
    console.error(`❌ Error hiding highlight ${highlightId}:`, error);
    throw error;

  }
}


/**
 * Restore hyperlit container from history state
 * Called when user navigates back to a page that had an open container
 */
export async function restoreHyperlitContainerFromHistory() {
  const historyState = history.state;
  
  if (!historyState || !historyState.hyperlitContainer) {
    console.log('📊 No hyperlit container state found in history');
    return false;
  }
  
  const containerState = historyState.hyperlitContainer;
  console.log('📊 Restoring hyperlit container from history:', containerState);
  
  try {
    // Reconstruct content types from stored state
    const contentTypes = [];
    
    for (const storedType of containerState.contentTypes) {
      let contentType = { ...storedType };
      
      // For hypercites, we might need to refetch some data
      if (storedType.type === 'hypercite' && storedType.hyperciteId) {
        const hyperciteData = await detectHypercites(null, storedType.hyperciteId);
        if (hyperciteData) {
          contentType = hyperciteData;
        }
      }
      
      // For highlights, refetch if we have IDs
      if (storedType.type === 'highlight' && storedType.highlightIds) {
        const highlightData = await detectHighlights(null, storedType.highlightIds);
        if (highlightData) {
          contentType = highlightData;
        }
      }
      
      contentTypes.push(contentType);
    }
    
    if (contentTypes.length > 0) {
      // Build and open the container
      const unifiedContent = await buildUnifiedContent(contentTypes, containerState.newHighlightIds || []);
      openHyperlitContainer(unifiedContent, true); // isBackNavigation = true
      
      // Handle post-open actions
      await handlePostOpenActions(contentTypes, containerState.newHighlightIds || []);
      
      console.log('✅ Successfully restored hyperlit container from history');
      return true;
    }
  } catch (error) {
    console.error('❌ Error restoring hyperlit container from history:', error);
  }
  
  return false;
}

/**
 * Get current container state for preservation during navigation
 * Returns null if no container is open
 */
export function getCurrentContainerState() {
  if (!hyperlitManager || !document.getElementById('hyperlit-container')?.style.display || 
      document.getElementById('hyperlit-container').style.display === 'none') {
    return null;
  }
  
  // Try to extract state from current container content
  // This is a fallback method - ideally state should be tracked during opening
  const container = document.getElementById('hyperlit-container');
  if (!container) return null;
  
  const state = {
    isOpen: true,
    timestamp: Date.now(),
    // Could extract more detailed state here if needed
    hasContent: container.innerHTML.length > 0
  };
  
  console.log('📊 Current container state:', state);
  return state;
}

export { hyperlitManager };

// Destroy function for cleanup during navigation
export function destroyHyperlitManager() {
  if (hyperlitManager) {
    console.log('🧹 Destroying hyperlit container manager');
    hyperlitManager.destroy();
    hyperlitManager = null;
    return true;
  }
  return false;
}
/**
 * Hyperlit Container System - Main Entry Point
 *
 * This module orchestrates all hyperlit container functionality:
 * - Footnotes, citations, hypercites, highlights display
 * - Unified content detection and rendering
 * - History management and navigation
 *
 * Replaces the monolithic unifiedContainer.js (2733 lines → modular structure)
 */

// ============================================================================
// IMPORTS FROM MODULES
// ============================================================================

// Core container lifecycle
export {
  initializeHyperlitManager,
  openHyperlitContainer,
  closeHyperlitContainer,
  destroyHyperlitManager,
  hyperlitManager
} from './core.js';

// Content type detection
export {
  detectContentTypes,
  detectFootnote,
  detectCitation,
  detectHighlights,
  detectHyperciteCitation,
  detectHypercites
} from './detection.js';

// Content builders
export { buildFootnoteContent } from './contentBuilders/displayFootnotes.js';
export { buildCitationContent, buildHyperciteCitationContent } from './contentBuilders/displayCitations.js';
export { buildHighlightContent } from './contentBuilders/displayHyperlights.js';
export {
  buildHyperciteContent,
  checkHyperciteExists,
  handleManageCitationsClick,
  handleHyperciteHealthCheck,
  handleHyperciteDelete
} from './contentBuilders/displayHypercites.js';

// History & navigation
export {
  determineSingleContentHash,
  restoreHyperlitContainerFromHistory,
  getCurrentContainerState
} from './history.js';

// Utilities
export {
  formatRelativeTime,
  fetchLibraryFromServer,
  scrollFocusedElementIntoView
} from './utils.js';

// ============================================================================
// LOCAL IMPORTS
// ============================================================================

import { book } from '../app.js';
import { openDatabase } from '../indexedDB/index.js';
import { getCurrentUserId } from "../utilities/auth.js";
import { openHyperlitContainer } from './core.js';
import { detectContentTypes } from './detection.js';
import { determineSingleContentHash } from './history.js';
import { buildFootnoteContent } from './contentBuilders/displayFootnotes.js';
import { buildCitationContent, buildHyperciteCitationContent } from './contentBuilders/displayCitations.js';
import { buildHighlightContent } from './contentBuilders/displayHyperlights.js';
import { buildHyperciteContent } from './contentBuilders/displayHypercites.js';

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

// Debounce mechanism to prevent duplicate calls
let isProcessingClick = false;

// ============================================================================
// MAIN ORCHESTRATION FUNCTIONS
// ============================================================================

/**
 * Main function to handle any element click and detect all overlapping content types
 * @param {HTMLElement} element - The clicked element
 * @param {Array} highlightIds - Optional array of highlight IDs if already known
 * @param {Array} newHighlightIds - Optional array of new highlight IDs
 * @param {boolean} skipUrlUpdate - Skip URL hash update
 * @param {boolean} isBackNavigation - Whether this is back navigation
 * @param {string} directHyperciteId - Optional direct hypercite ID
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
    // 🚀 PERFORMANCE: Open DB once and reuse throughout
    const db = await openDatabase();
    let contentTypes = [];

    // If this is a history navigation, we have no element, only an ID.
    // We can skip the broad detection and go straight to finding the content.
    if (!element && directHyperciteId) {
        console.log(`🎯 History navigation detected for: ${directHyperciteId}. Detecting content directly.`);

        // Determine content type from the ID and detect accordingly
        if (directHyperciteId.startsWith('hypercite_')) {
          const { detectHypercites } = await import('./detection.js');
          const hyperciteData = await detectHypercites(null, directHyperciteId, db);
          if (hyperciteData) {
            contentTypes.push(hyperciteData);
          }
        } else if (directHyperciteId.startsWith('HL_')) {
          const { detectHighlights } = await import('./detection.js');
          const highlightData = await detectHighlights(null, [directHyperciteId], db);
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
        contentTypes = await detectContentTypes(element, highlightIds, directHyperciteId, db);
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

    // Build unified content (pass db for reuse)
    const unifiedContent = await buildUnifiedContent(contentTypes, newHighlightIds, db);

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
 * Build unified content HTML from detected content types
 * @param {Array} contentTypes - Array of content type objects
 * @param {Array} newHighlightIds - Array of new highlight IDs
 * @param {IDBDatabase} db - Reused database connection
 * @returns {Promise<string>} HTML content string
 */
export async function buildUnifiedContent(contentTypes, newHighlightIds = [], db = null) {
  console.log("🔨 Building unified content for types:", contentTypes.map(ct => ct.type));

  let contentTypesWithTimestamps;

  // 🚀 PERFORMANCE: Skip timestamp fetching if only one content type (no sorting needed)
  if (contentTypes.length === 1) {
    console.log("⚡ Single content type - skipping timestamp fetch");
    contentTypesWithTimestamps = contentTypes.map(ct => ({ ...ct, timestamp: 0 }));
  } else {
    // Fetch timestamps for each content type to sort chronologically
    const database = db || await openDatabase();

    contentTypesWithTimestamps = await Promise.all(
      contentTypes.map(async (contentType) => {
        let timestamp = 0; // Default to 0 for items without timestamps (footnotes, citations)

        try {
          if (contentType.type === 'highlight') {
            // Get timestamp from highlight data
            const tx = database.transaction("hyperlights", "readonly");
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
            // 🚀 Use cached data if available
            if (contentType.cachedData && contentType.cachedData.time_since) {
              timestamp = contentType.cachedData.time_since;
            } else {
              // Fall back to query if not cached
              const tx = database.transaction("hypercites", "readonly");
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
          }
          // Footnotes and citations don't have creation timestamps, so they stay at 0
        } catch (error) {
          console.warn(`Error getting timestamp for ${contentType.type}:`, error);
        }

        return { ...contentType, timestamp };
      })
    );

    // Sort by content type priority: hypercite-citation first, then footnotes/citations, then hypercites, then highlights
    const typePriority = {
      'hypercite-citation': 1,
      'footnote': 2,
      'citation': 3,
      'hypercite': 4,
      'highlight': 5
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
  }

  let contentHtml = '';

  // Process each content type in chronological order
  for (const contentType of contentTypesWithTimestamps) {
    console.log(`🔨 Processing ${contentType.type} content...`);

    switch (contentType.type) {
      case 'footnote':
        const footnoteHtml = await buildFootnoteContent(contentType, db);
        if (footnoteHtml) {
          console.log(`✅ Added footnote content (${footnoteHtml.length} chars)`);
          contentHtml += footnoteHtml;
        }
        break;

      case 'citation':
        const citationHtml = await buildCitationContent(contentType, db);
        if (citationHtml) {
          console.log(`✅ Added citation content (${citationHtml.length} chars)`);
          contentHtml += citationHtml;
        }
        break;

      case 'hypercite-citation':
        const hyperciteCitationHtml = await buildHyperciteCitationContent(contentType, db);
        if (hyperciteCitationHtml) {
          console.log(`✅ Added hypercite citation content (${hyperciteCitationHtml.length} chars)`);
          contentHtml += hyperciteCitationHtml;
        }
        break;

      case 'highlight':
        const highlightHtml = await buildHighlightContent(contentType, newHighlightIds, db);
        if (highlightHtml) {
          console.log(`✅ Added highlight content (${highlightHtml.length} chars)`);
          contentHtml += highlightHtml;
        } else {
          console.warn("⚠️ No highlight content generated");
        }
        break;

      case 'hypercite':
        const hyperciteHtml = await buildHyperciteContent(contentType, db);
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
 * Handle post-open actions like cursor placement
 * @param {Array} contentTypes - Array of content type objects
 * @param {Array} newHighlightIds - Array of new highlight IDs
 */
export async function handlePostOpenActions(contentTypes, newHighlightIds = []) {
  // Handle highlight-specific post-open actions
  const highlightType = contentTypes.find(ct => ct.type === 'highlight');
  if (highlightType) {
    try {
      // Import the required functions
      const { attachAnnotationListener, addHighlightContainerPasteListener, attachPlaceholderBehavior } = await import('../hyperlights/index.js');

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
      setTimeout(async () => {
        const { deleteHighlightById } = await import('../hyperlights/index.js');
        const deleteButtons = document.querySelectorAll('.delete-highlight-btn');
        deleteButtons.forEach(button => {
          button.addEventListener('click', async (e) => {
            const highlightId = button.getAttribute('data-highlight-id');
            const action = button.getAttribute('data-action'); // 'delete' or 'hide'
            await deleteHighlightById(highlightId);
          });
        });
      }, 200);

    } catch (error) {
      console.error('Error in highlight post-actions:', error);
    }
  }

  // Always attach listeners for management buttons and private book checks
  setTimeout(async () => {
    // Attach data-content-id link listeners for URL updates
    attachDataContentIdLinkListeners();

    // Defer private book access checks to avoid blocking container opening
    // Use requestIdleCallback for non-critical background work
    if (window.requestIdleCallback) {
      requestIdleCallback(() => checkPrivateBookAccess());
    } else {
      // Fallback for browsers without requestIdleCallback
      setTimeout(() => checkPrivateBookAccess(), 200);
    }

    // Attach manage citations button listener
    const manageCitationsBtn = document.querySelector('.manage-citations-btn');
    if (manageCitationsBtn) {
      const { handleManageCitationsClick } = await import('./contentBuilders/displayHypercites.js');
      manageCitationsBtn.addEventListener('click', handleManageCitationsClick);
    }
  }, 100);
}

/**
 * Attach listeners to data-content-id links for URL updates
 * @private
 */
function attachDataContentIdLinkListeners() {
  const links = document.querySelectorAll('[data-content-id]');
  links.forEach(link => {
    link.addEventListener('click', (e) => {
      const contentId = link.getAttribute('data-content-id');
      if (contentId) {
        console.log(`🔗 Clicked link with content ID: ${contentId}`);
        // URL update logic handled by navigation system
      }
    });
  });
}

/**
 * Check private book access and update UI accordingly
 * @private
 */
async function checkPrivateBookAccess() {
  const privateLinks = document.querySelectorAll('[data-private="true"]');
  if (privateLinks.length === 0) return;

  const { canUserEditBook } = await import('../utilities/auth.js');

  for (const link of privateLinks) {
    const bookId = link.getAttribute('data-book-id');
    if (bookId) {
      const hasAccess = await canUserEditBook(bookId);
      if (!hasAccess) {
        link.style.opacity = '0.6';
        link.style.cursor = 'not-allowed';
        link.addEventListener('click', (e) => {
          e.preventDefault();
          alert('This book is private. You don not have access.');
        });
      }
    }
  }
}

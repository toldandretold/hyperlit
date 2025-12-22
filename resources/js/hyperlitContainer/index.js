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
  hyperlitManager,
  getHyperlitEditMode,
  setHyperlitEditMode,
  toggleHyperlitEditMode
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
import { getCurrentUserId, canUserEditBook } from "../utilities/auth.js";
import { openHyperlitContainer, getHyperlitEditMode, setHyperlitEditMode, toggleHyperlitEditMode } from './core.js';
import { detectContentTypes } from './detection.js';
import { determineSingleContentHash } from './history.js';
import { buildFootnoteContent } from './contentBuilders/displayFootnotes.js';
import { buildCitationContent, buildHyperciteCitationContent } from './contentBuilders/displayCitations.js';
import { buildHighlightContent } from './contentBuilders/displayHyperlights.js';
import { buildHyperciteContent } from './contentBuilders/displayHypercites.js';
import { attachNoteListeners, initializePlaceholders } from './noteListener.js';

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

// Debounce mechanism to prevent duplicate calls
let isProcessingClick = false;

// ============================================================================
// LISTENER CLEANUP INFRASTRUCTURE
// ============================================================================
// Prevents listener accumulation by tracking all listeners added during container open
// and removing them when the container closes

const activeListeners = [];

/**
 * Register an event listener and track it for cleanup
 * @param {HTMLElement} element - The element to attach the listener to
 * @param {string} event - The event type (e.g., 'click', 'input')
 * @param {Function} handler - The event handler function
 * @param {Object} options - Optional event listener options
 */
function registerListener(element, event, handler, options = {}) {
  element.addEventListener(event, handler, options);
  activeListeners.push({ element, event, handler, options });
}

/**
 * Clean up all registered listeners
 * Called when the container closes to prevent listener accumulation
 */
export function cleanupContainerListeners() {
  for (const { element, event, handler, options } of activeListeners) {
    try {
      element.removeEventListener(event, handler, options);
    } catch (e) {
      // Element may have been removed from DOM, ignore
    }
  }
  activeListeners.length = 0;
}

// ============================================================================
// EDIT BUTTON HELPERS
// ============================================================================

/**
 * Build the edit button HTML
 * @param {boolean} isActive - Whether edit mode is currently active
 * @returns {string} HTML string for edit button
 */
function buildEditButtonHtml(isActive) {
  return `
    <button id="hyperlit-edit-btn" class="${isActive ? 'inverted' : ''}"
            title="${isActive ? 'Exit edit mode' : 'Enter edit mode'}">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;">
        <path d="M12 20h9" stroke="#CBCCCC"></path>
        <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" stroke="#CBCCCC"></path>
      </svg>
    </button>`;
}

/**
 * Check if user has permission to edit ANY item in the content types
 * Used to determine whether to show the edit button
 * @param {Array} contentTypes - Array of content type objects
 * @param {Array} newHighlightIds - Array of newly created highlight IDs
 * @param {IDBDatabase} db - Database connection
 * @returns {Promise<boolean>} Whether user can edit at least one item
 */
export async function checkIfUserHasAnyEditPermission(contentTypes, newHighlightIds = [], db = null) {
  const currentUserId = await getCurrentUserId();

  // Check footnotes and citations (book-level permission)
  const hasFootnoteOrCitation = contentTypes.some(ct => ct.type === 'footnote' || ct.type === 'citation');
  if (hasFootnoteOrCitation) {
    if (await canUserEditBook(book)) {
      return true;
    }
  }

  // Check highlights (item-level permission)
  const highlightType = contentTypes.find(ct => ct.type === 'highlight');
  if (highlightType) {
    // If there are newly created highlights, user can edit those
    if (newHighlightIds && newHighlightIds.length > 0) {
      return true;
    }

    // Check if user owns any of the highlights
    const database = db || await openDatabase();
    const tx = database.transaction("hyperlights", "readonly");
    const store = tx.objectStore("hyperlights");
    const idx = store.index("hyperlight_id");

    for (const id of highlightType.highlightIds) {
      const result = await new Promise((res) => {
        const req = idx.get(id);
        req.onsuccess = () => res(req.result);
        req.onerror = () => res(null);
      });

      if (result) {
        const isUserHighlight = result.is_user_highlight !== undefined
          ? result.is_user_highlight
          : (result.creator ? result.creator === currentUserId : result.creator_token === currentUserId);

        if (isUserHighlight) {
          return true;
        }
      }
    }
  }

  // Note: Hypercites are intentionally NOT checked here.
  // The "Cited By" section (for couple/poly hypercites) is read-only,
  // and "single" hypercites just show an informational message.
  // Edit button should only show if there's other editable content (footnotes, citations, highlights).

  return false;
}

/**
 * Handle edit button click - toggle edit mode in-place without rebuilding content
 * Preserves scroll position and simply toggles contenteditable attributes
 */
async function handleEditButtonClick() {
  const newState = toggleHyperlitEditMode();
  const editBtn = document.getElementById('hyperlit-edit-btn');
  const container = document.getElementById('hyperlit-container');
  const scroller = container?.querySelector('.scroller');

  // Save scroll position BEFORE any DOM changes
  const scrollTop = scroller?.scrollTop || 0;

  // Update button visual state
  if (editBtn) {
    if (newState) {
      editBtn.classList.add('inverted');
      editBtn.title = 'Exit edit mode';
    } else {
      editBtn.classList.remove('inverted');
      editBtn.title = 'Enter edit mode';
    }
  }

  // Toggle contenteditable on all editable elements in-place
  toggleContentEditableInPlace(newState);

  // Attach or detach edit listeners
  if (newState) {
    const { attachNoteListeners, initializePlaceholders } = await import('./noteListener.js');
    attachNoteListeners();
    initializePlaceholders();
  } else {
    const { detachNoteListeners } = await import('./noteListener.js');
    detachNoteListeners();
  }

  // Restore scroll position
  if (scroller) {
    scroller.scrollTop = scrollTop;
  }

  // If entering edit mode, focus topmost editable (without scrolling)
  if (newState) {
    focusTopmostEditableElement(true); // preventScroll = true
  }
}

/**
 * Focus the topmost editable element in the hyperlit container
 * Priority: footnote first, then first editable annotation
 * @param {boolean} preventScroll - If true, prevents scrolling when focusing
 */
function focusTopmostEditableElement(preventScroll = false) {
  const container = document.getElementById('hyperlit-container');
  if (!container) return;

  // First try to find an editable footnote (always at the top when present)
  const editableFootnote = container.querySelector('.footnote-text[contenteditable="true"]');
  if (editableFootnote) {
    editableFootnote.focus({ preventScroll });
    // Place cursor at end of content
    placeCursorAtEnd(editableFootnote);
    console.log('✏️ Focused topmost editable footnote');
    return;
  }

  // Otherwise find the first editable annotation (highlight annotation)
  const editableAnnotation = container.querySelector('.annotation[contenteditable="true"]');
  if (editableAnnotation) {
    editableAnnotation.focus({ preventScroll });
    // Place cursor at end of content
    placeCursorAtEnd(editableAnnotation);
    console.log('✏️ Focused topmost editable annotation');
    return;
  }

  console.log('✏️ No editable elements found to focus');
}

/**
 * Toggle contenteditable attribute on all editable elements in-place
 * Uses data-user-can-edit attribute to determine which elements should be toggled
 * @param {boolean} enabled - Whether edit mode is enabled
 */
function toggleContentEditableInPlace(enabled) {
  const container = document.getElementById('hyperlit-container');
  if (!container) return;

  // Toggle footnotes (user must have permission - check data attribute)
  container.querySelectorAll('.footnote-text[data-user-can-edit="true"]').forEach(el => {
    el.contentEditable = enabled ? 'true' : 'false';
  });

  // Toggle annotations (user must have permission - check data attribute)
  container.querySelectorAll('.annotation[data-user-can-edit="true"]').forEach(el => {
    el.contentEditable = enabled ? 'true' : 'false';
  });

  // Toggle highlight text (user must have permission - check data attribute)
  container.querySelectorAll('.highlight-text[data-user-can-edit="true"]').forEach(el => {
    el.contentEditable = enabled ? 'true' : 'false';
  });

  console.log(`✏️ Toggled contenteditable=${enabled} on editable elements`);
}

/**
 * Place cursor at the end of a contenteditable element
 * @param {HTMLElement} element - The contenteditable element
 */
function placeCursorAtEnd(element) {
  const range = document.createRange();
  const selection = window.getSelection();
  range.selectNodeContents(element);
  range.collapse(false); // false = collapse to end
  selection.removeAllRanges();
  selection.addRange(range);
}

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
 * @param {boolean} isNewFootnote - Whether this is a newly inserted footnote (should auto-focus)
 */
export async function handleUnifiedContentClick(element, highlightIds = null, newHighlightIds = [], skipUrlUpdate = false, isBackNavigation = false, directHyperciteId = null, isNewFootnote = false) {
  const logElement = element ? (element.id || element.tagName) : (directHyperciteId || 'No element');
  console.log("🎯 handleUnifiedContentClick called with:", { element: logElement, isBackNavigation, directHyperciteId, isProcessingClick });

  // 🔑 iOS Safari Keyboard Fix: Pre-focus a hidden input IMMEDIATELY (synchronously)
  // This preserves the user gesture chain so the keyboard will open later
  // The hidden input is positioned inside hyperlit-container so focus transfers naturally
  let focusPreserver = null;
  const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  // Check if this might be a footnote click (sup with fn-count-id or a.footnote-ref)
  const mightBeFootnote = element && (
    (element.tagName === 'SUP' && element.hasAttribute('fn-count-id')) ||
    (element.tagName === 'A' && element.classList.contains('footnote-ref')) ||
    element.closest('sup[fn-count-id]')
  );

  if (mightBeFootnote && !isBackNavigation) {
    // Create and focus a hidden input synchronously to preserve user gesture
    focusPreserver = document.createElement('input');
    focusPreserver.type = 'text';
    focusPreserver.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;';
    focusPreserver.id = 'focus-preserver';
    document.body.appendChild(focusPreserver);
    focusPreserver.focus();
    console.log('🔑 Focus preserver activated for potential footnote');
  }

  if (isProcessingClick) {
    console.log("🚫 Click already being processed, ignoring duplicate. Current flag state:", isProcessingClick);
    console.log("🚫 Call stack:", new Error().stack);
    if (focusPreserver) focusPreserver.remove();
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
          footnoteId: ct.footnoteId,  // Also store footnoteId for footnotes
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

    // =========================================================================
    // EDIT MODE: Auto-enable for newly created items
    // =========================================================================
    const hasJustCreatedItem = isNewFootnote || (newHighlightIds && newHighlightIds.length > 0);
    if (hasJustCreatedItem && !isBackNavigation) {
      console.log('✏️ Just-created item detected, auto-enabling edit mode');
      setHyperlitEditMode(true);
    }

    // Check if user has permission to edit ANY item (determines if edit button shows)
    const hasAnyEditPermission = await checkIfUserHasAnyEditPermission(contentTypes, newHighlightIds, db);
    console.log(`✏️ User has edit permission: ${hasAnyEditPermission}`);

    // Get current edit mode state
    const editModeEnabled = getHyperlitEditMode();
    console.log(`✏️ Edit mode enabled: ${editModeEnabled}`);

    // Build unified content (pass db for reuse and edit mode state)
    const unifiedContent = await buildUnifiedContent(contentTypes, newHighlightIds, db, editModeEnabled, hasAnyEditPermission);

    console.log(`📦 Built unified content (${unifiedContent.length} chars)`);

    // Open the unified container
    openHyperlitContainer(unifiedContent, isBackNavigation);

    // Handle any post-open actions (like cursor placement for editable content)
    // Pass focusPreserver so footnote focus can transfer from it (preserves keyboard on iOS)
    // Pass isNewFootnote so we only auto-focus for newly inserted footnotes
    // Pass hasAnyEditPermission so we can attach edit button listener
    await handlePostOpenActions(contentTypes, newHighlightIds, focusPreserver, isNewFootnote, hasAnyEditPermission);

  } catch (error) {
    console.error("❌ Error in unified content handler:", error);
  } finally {
    // Clean up focus preserver if it wasn't used (e.g., not a footnote after all)
    if (focusPreserver && focusPreserver.parentNode) {
      focusPreserver.remove();
    }
    // Reset the processing flag immediately (no delay needed)
    isProcessingClick = false;
    console.log("🔄 Reset isProcessingClick flag");
  }
}

/**
 * Build unified content HTML from detected content types
 * @param {Array} contentTypes - Array of content type objects
 * @param {Array} newHighlightIds - Array of new highlight IDs
 * @param {IDBDatabase} db - Reused database connection
 * @param {boolean} editModeEnabled - Whether edit mode is currently enabled
 * @param {boolean} hasAnyEditPermission - Whether user has permission to edit any item
 * @returns {Promise<string>} HTML content string
 */
export async function buildUnifiedContent(contentTypes, newHighlightIds = [], db = null, editModeEnabled = true, hasAnyEditPermission = false) {
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
        const footnoteHtml = await buildFootnoteContent(contentType, db, editModeEnabled);
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
        const highlightHtml = await buildHighlightContent(contentType, newHighlightIds, db, editModeEnabled);
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

  // Append edit button if user has edit permission
  if (hasAnyEditPermission) {
    contentHtml += buildEditButtonHtml(editModeEnabled);
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
 * @param {HTMLElement} focusPreserver - Hidden input that preserves user gesture for keyboard (iOS)
 * @param {boolean} isNewFootnote - Whether this is a newly inserted footnote (should auto-focus)
 * @param {boolean} hasAnyEditPermission - Whether user has permission to edit any item
 * @param {boolean} skipAutoFocus - Skip auto-focus (used when edit button handles focus separately)
 */
export async function handlePostOpenActions(contentTypes, newHighlightIds = [], focusPreserver = null, isNewFootnote = false, hasAnyEditPermission = false, skipAutoFocus = false) {
  const editModeEnabled = getHyperlitEditMode();

  // Only attach note listeners if edit mode is enabled
  // This prevents editing when in read mode
  if (editModeEnabled) {
    attachNoteListeners();
    initializePlaceholders();
  }

  // Handle highlight-specific post-open actions
  const highlightType = contentTypes.find(ct => ct.type === 'highlight');
  if (highlightType) {
    try {
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

      // Find first editable highlight for cursor placement
      results.forEach((highlight) => {
        if (highlight) {
          // 🔒 SECURITY: Prefer server-calculated is_user_highlight (doesn't expose tokens)
          // Fall back to local comparison only for locally-created highlights not yet synced
          const isUserHighlight = highlight.is_user_highlight !== undefined
            ? highlight.is_user_highlight
            : (highlight.creator ? highlight.creator === currentUserId : (!highlight.creator && highlight.creator_token === currentUserId));
          const isNewlyCreated = newHighlightIds.includes(highlight.hyperlight_id);
          const isEditable = isUserHighlight || isNewlyCreated;

          if (isEditable && !firstUserAnnotation) {
            firstUserAnnotation = highlight.hyperlight_id;
          }
        }
      });

      // Place cursor in first user annotation if available AND edit mode is enabled
      // Skip if skipAutoFocus is true (edit button handles focus separately)
      if (firstUserAnnotation && editModeEnabled && !skipAutoFocus) {
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

      // Attach delete/hide button listeners using event delegation on container
      // This prevents listener accumulation - one listener handles all buttons
      setTimeout(async () => {
        const { deleteHighlightById, hideHighlightById } = await import('../hyperlights/index.js');
        const container = document.getElementById('hyperlit-container');
        if (container) {
          const handler = async (e) => {
            const button = e.target.closest('.delete-highlight-btn');
            if (!button) return;

            const highlightId = button.getAttribute('data-highlight-id');
            const action = button.getAttribute('data-action'); // 'delete' or 'hide'

            if (action === 'hide') {
              // Book owner hiding someone else's highlight - sets hidden=true
              await hideHighlightById(highlightId);
            } else {
              // User deleting their own highlight - permanent removal
              await deleteHighlightById(highlightId);
            }
          };
          registerListener(container, 'click', handler);
        }
      }, 200);

    } catch (error) {
      console.error('Error in highlight post-actions:', error);
    }
  }

  // Handle footnote-specific post-open actions
  const footnoteType = contentTypes.find(ct => ct.type === 'footnote');
  if (footnoteType) {
    try {
      // Get the footnote ID from the content type (already extracted by detection)
      const footnoteId = footnoteType.footnoteId;

      if (footnoteId) {
        // Content is now inserted synchronously, so element should exist immediately
        const footnoteEl = document.querySelector(
          `.footnote-text[data-footnote-id="${footnoteId}"]`
        );

        // Only focus and place cursor if edit mode is enabled
        // Skip if skipAutoFocus is true (edit button handles focus separately)
        if (footnoteEl && editModeEnabled && !skipAutoFocus) {
          const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
          if (!isMobile) {
            // Focus the footnote element and place cursor at end
            footnoteEl.focus();

            try {
              const selection = window.getSelection();
              const range = document.createRange();
              range.selectNodeContents(footnoteEl);
              range.collapse(false);
              selection.removeAllRanges();
              selection.addRange(range);
            } catch (e) {
              // Ignore selection errors
            }
          }

          // Clean up the focus preserver
          if (focusPreserver && focusPreserver.parentNode) {
            focusPreserver.remove();
          }
        } else if (!footnoteEl) {
          console.error(`❌ Footnote element not found: ${footnoteId}`);
        }
      }
    } catch (error) {
      console.error('Error in footnote post-actions:', error);
    }
  }

  // Always attach listeners for management buttons and private book checks
  setTimeout(async () => {
    // Attach data-content-id link listeners for URL updates
    attachDataContentIdLinkListeners();

    // Skip private book checks for footnotes - already checked during content building
    const hasFootnoteOnly = contentTypes.length === 1 && contentTypes[0].type === 'footnote';
    if (!hasFootnoteOnly) {
      // Defer private book access checks to avoid blocking container opening
      // Use requestIdleCallback for non-critical background work
      if (window.requestIdleCallback) {
        requestIdleCallback(() => checkPrivateBookAccess());
      } else {
        // Fallback for browsers without requestIdleCallback
        setTimeout(() => checkPrivateBookAccess(), 200);
      }
    }

    // Attach manage citations button listener using registerListener for cleanup
    const manageCitationsBtn = document.querySelector('.manage-citations-btn');
    if (manageCitationsBtn) {
      const { handleManageCitationsClick } = await import('./contentBuilders/displayHypercites.js');
      registerListener(manageCitationsBtn, 'click', handleManageCitationsClick);
    }

    // Attach edit button click handler if user has edit permission
    if (hasAnyEditPermission) {
      const editBtn = document.getElementById('hyperlit-edit-btn');
      if (editBtn) {
        registerListener(editBtn, 'click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          handleEditButtonClick();
        });
      }
    }
  }, 100);
}

/**
 * Attach listeners to data-content-id links for URL updates
 * Uses registerListener for proper cleanup when container closes
 * @private
 */
function attachDataContentIdLinkListeners() {
  const links = document.querySelectorAll('[data-content-id]');
  links.forEach(link => {
    const handler = (e) => {
      const contentId = link.getAttribute('data-content-id');
      if (contentId) {
        console.log(`🔗 Clicked link with content ID: ${contentId}`);
        // URL update logic handled by navigation system
      }
    };
    registerListener(link, 'click', handler);
  });
}

/**
 * Check private book access and update UI accordingly
 * Uses registerListener for proper cleanup when container closes
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
        const handler = (e) => {
          e.preventDefault();
          alert('This book is private. You do not have access.');
        };
        registerListener(link, 'click', handler);
      }
    }
  }
}

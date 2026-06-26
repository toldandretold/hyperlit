/**
 * Hyperlit Container System - Main Entry Point
 *
 * This module orchestrates all hyperlit container functionality:
 * - Footnotes, citations, hypercites, highlights display
 * - Unified content detection and rendering
 * - History management and navigation
 *
 * Replaces the monolithic unifiedContainer.js (2733 lines → modular structure)
 *
 * EDIT MODE DESIGN:
 * - Main edit button controls main content ONLY — container edit state never leaks back.
 * - Container edit button is a SHARED GLOBAL toggle (isHyperlitEditMode).
 *   Toggle OFF in ANY container → all containers enter read mode.
 *   Toggle ON → all containers enter edit mode.
 * - Popping a stacked layer applies the CURRENT isHyperlitEditMode,
 *   NOT a per-layer saved value. See applyCurrentEditModeToLayer().
 */

// ============================================================================
// IMPORTS FROM MODULES
// ============================================================================

// Core container lifecycle
export {
  initializeHyperlitManager,
  openHyperlitContainer,
  prepareHyperlitContainer,
  animateHyperlitContainerOpen,
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
export { buildCitationContent, buildHyperciteCitationContent, resolveButtonStatus } from './contentBuilders/displayCitations.js';
export { buildHighlightContent } from './contentBuilders/displayHyperlights.js';
export {
  buildHyperciteContent,
  checkHyperciteExists,
  handleManageCitationsClick,
  handleHyperciteHealthCheck,
  handleHyperciteDelete
} from './contentBuilders/displayHypercites/index.js';

// History & navigation
export {
  determineSingleContentHash,
  restoreHyperlitContainerFromHistory,
  getCurrentContainerState,
  buildContentFromMetadata,
  restoreStackedLayer,
  restoreContainerStack
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

import { book } from '../app';
import { resetSubBookState, restoreSubBookState, saveSubBookState } from './subBookActions';
import { clearActiveBook } from './utilities/activeContext';
import { openDatabase } from '../indexedDB/index';
import { getAuthContextSync, getAuthContext, canUserEditBook } from "../utilities/auth/index";
import { openHyperlitContainer, prepareHyperlitContainer, animateHyperlitContainerOpen, getHyperlitEditMode, setHyperlitEditMode, toggleHyperlitEditMode, prepareContainerClose, closeHyperlitContainer, initializeHyperlitManager } from './core.js';
import { ProgressOverlayConductor } from '../SPA/navigation/ProgressOverlayConductor.js';
import { detectContentTypes } from './detection.js';
import { determineSingleContentHash, pickAnchorId } from './history.js';
import { buildFootnoteContent } from './contentBuilders/displayFootnotes.js';
import { buildCitationContent, buildHyperciteCitationContent } from './contentBuilders/displayCitations.js';
import { buildHighlightContent } from './contentBuilders/displayHyperlights.js';
import { buildHyperciteContent, handleHyperciteHealthCheck, handleHyperciteDelete } from './contentBuilders/displayHypercites/index.js';
import { attachNoteListeners, initializePlaceholders } from './noteListener.js';
import { getCurrentContainer, isStackPopping } from './stack.js';
import { registerContainerActions } from './containerActions';
import { buildSubBookId } from '../utilities/subBookIdHelper';

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

// Orchestrator state + listener registry + module-state snapshot live in the ./containerState
// leaf, shared with editMode/containerListeners/postOpen WITHOUT importing back into ./index.
import {
  containerState,
  activeListeners,
  registerListener,
  saveModuleState,
  restoreModuleState,
  resetModuleState,
  isClickProcessing,
} from './containerState';
export { isClickProcessing, saveModuleState, restoreModuleState, resetModuleState };

// Edit-mode/focus controls + listener lifecycle now live in their own modules
// (extracted from index so postOpen/stack/core use them without importing ./index).
import {
  buildEditButtonHtml,
  handleEditButtonClick,
  attachSubBookFocusSwitcher,
  applyCurrentEditModeToLayer,
} from './editMode';
import {
  cleanupContainerListeners,
} from './containerListeners';
export { applyCurrentEditModeToLayer, cleanupContainerListeners };

// The per-content-type orchestrators now live in their own modules (consuming the
// contentTypes/ registry). index keeps the click/stack core and re-exports these so
// external callers + history are unchanged. history imports them directly → no cycle.
import { buildUnifiedContent } from './contentBuild';
import { handlePostOpenActions } from './postOpen';
import { checkIfUserHasAnyEditPermission } from './permissions';
export { buildUnifiedContent, handlePostOpenActions, checkIfUserHasAnyEditPermission };

// Wire the container's public actions into the DI registry so feature modules (hypercites,
// hyperlights) can drive the container WITHOUT importing hyperlitContainer/* (breaking the
// feature↔orchestrator cycle). Runs at module load — footnotesCitations.js (the Vite entry)
// imports this module at bootstrap, before any feature invokes an action.
registerContainerActions({
  openHyperlitContainer, closeHyperlitContainer, initializeHyperlitManager,
  getCurrentContainer, isStackPopping,
  handleUnifiedContentClick, handleHyperciteHealthCheck, handleHyperciteDelete,
});










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
export async function handleUnifiedContentClick(element: any, highlightIds: any = null, newHighlightIds: any = [], skipUrlUpdate: any = false, isBackNavigation: any = false, directHyperciteId: any = null, isNewFootnote: any = false, options: any = {}) {
  const logElement = element ? (element.id || element.tagName) : (directHyperciteId || 'No element');
  console.log("🎯 handleUnifiedContentClick called with:", { element: logElement, isBackNavigation, directHyperciteId, isProcessingClick: containerState.isProcessingClick });

  // 🔑 iOS Safari Keyboard Fix: Pre-focus a hidden input IMMEDIATELY (synchronously)
  // This preserves the user gesture chain so the keyboard will open later
  // The hidden input is positioned inside hyperlit-container so focus transfers naturally
  let focusPreserver: any = null;
  const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  // Check if this might be a footnote click (sup with fn-count-id or a.footnote-ref)
  const mightBeFootnote = element && (
    (element.tagName === 'SUP' && element.hasAttribute('fn-count-id')) ||
    (element.tagName === 'A' && element.classList.contains('footnote-ref')) ||
    element.closest('sup[fn-count-id]')
  );

  // Only create focus-preserver on desktop - on mobile we skip footnote focus anyway (line 837-840)
  // Creating it on mobile just triggers iOS keyboard preparation with no benefit
  if (mightBeFootnote && !isBackNavigation && !isMobile) {
    // Create and focus a hidden input synchronously to preserve user gesture
    focusPreserver = document.createElement('input');
    focusPreserver.type = 'text';
    // Position at 0,0 (not -9999px) to avoid scroll quirks, but invisible
    focusPreserver.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    focusPreserver.id = 'focus-preserver';
    document.body.appendChild(focusPreserver);
    focusPreserver.focus({ preventScroll: true });
    console.log('🔑 Focus preserver activated for potential footnote');
  }

  if (containerState.isProcessingClick) {
    console.log("🚫 Click already being processed, ignoring duplicate. Current flag state:", containerState.isProcessingClick);
    console.log("🚫 Call stack:", new Error().stack);
    if (focusPreserver) focusPreserver.remove();
    return;
  }
  console.log("✅ Setting containerState.isProcessingClick to true");
  containerState.isProcessingClick = true;

  try {
    // =========================================================================
    // STACK DETECTION: If click originates from inside an existing container,
    // push a new stacked layer instead of replacing the current one.
    // =========================================================================
    if (element && !isBackNavigation) {
      const { isStacked, getDepth, getCurrentContainer: getContainer }: any = await import('./stack.js');
      const sourceContainer = element.closest('.hyperlit-container-stacked, #hyperlit-container');
      if (sourceContainer) {
        console.log(`📚 Click from inside container at depth ${getDepth()}, pushing stacked layer`);
        if (focusPreserver) focusPreserver.remove();
        await pushStackedLayer(element, highlightIds, newHighlightIds, skipUrlUpdate, directHyperciteId, isNewFootnote, options);
        containerState.isProcessingClick = false;
        return;
      }
    }

    // 🚀 PERFORMANCE: Open DB once and reuse throughout
    const db: any = await openDatabase();
    let contentTypes: any = [];

    // If this is a history navigation, we have no element, only an ID.
    // We can skip the broad detection and go straight to finding the content.
    if (!element && directHyperciteId) {
        console.log(`🎯 History navigation detected for: ${directHyperciteId}. Detecting content directly.`);

        // Determine content type from the ID and detect accordingly
        if (directHyperciteId.startsWith('hypercite_')) {
          const { detectHypercites }: any = await import('./detection.js');
          const hyperciteData: any = await detectHypercites(null, directHyperciteId, db);
          if (hyperciteData) {
            contentTypes.push(hyperciteData);
          }
        } else if (directHyperciteId.startsWith('HL_')) {
          const { detectHighlights }: any = await import('./detection.js');
          const highlightData: any = await detectHighlights(null, [directHyperciteId], db);
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
        containerState.isProcessingClick = false;
        return;
    }

    if (contentTypes.length === 0) {
      console.log("No hyperlit content detected.");
      containerState.isProcessingClick = false;
      return;
    }

    console.log(`📊 Detected content types: ${contentTypes.map((c: any) => c.type).join(', ')}`);

    // The single in-book element id this container scrolls the reader back to (the exact thing the
    // user clicked, precise-element first). Computed from the LIVE content types — while we still
    // have each type's `.element` — and stored on the layer so back/forward/refresh can reuse it.
    const anchorId = pickAnchorId(contentTypes);

    // Computed URL for the fresh-open history entry — set by the URL block
    // below, consumed by the pushLayer + syncStackToHistoryState call further
    // down. Stays null when the block is skipped (back nav, hypercite-preserve,
    // multi-content, etc.) — in those cases pushState reuses the current URL.
    let pendingUrlOverride: any = null;

    // Store container state in history for back button support
    if (!skipUrlUpdate && !isBackNavigation) {
      const containerState = {
        contentTypes: contentTypes.map((ct: any) => ({
          type: ct.type,
          hyperciteId: ct.hyperciteId,
          highlightIds: ct.highlightIds,
          fnCountId: ct.fnCountId,
          elementId: ct.elementId,
          footnoteId: ct.footnoteId,
          referenceId: ct.referenceId,
          relationshipStatus: ct.relationshipStatus,
          parentBookId: ct.parentBookId || null,
        })),
        anchorId,
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

      // Determine if we should update URL (only for single content types).
      // We COMPUTE the URL here but do NOT call replaceState — the URL change
      // belongs to the new history entry that the upcoming push will create,
      // not to the previous (book-empty) entry. The previous entry's URL
      // must stay clean so back-button lands on it cleanly.
      const urlUpdate = determineSingleContentHash(contentTypes);
      if (urlUpdate) {
        const currentHash = window.location.hash.substring(1);
        const hasHyperciteTarget = currentHash && currentHash.startsWith('hypercite_');

        if (hasHyperciteTarget && contentTypes[0].type === 'highlight') {
          // Preserve the original hypercite hash for in-container scrolling
          console.log(`📊 Preserving hypercite target in URL: #${currentHash}`);
        } else if (urlUpdate.type === 'path') {
          // Path-based URL (for footnotes): /book/footnoteID
          const pathSegments = window.location.pathname.split('/').filter(Boolean);
          const bookSlug = pathSegments[0] || '';
          pendingUrlOverride = `/${bookSlug}/${urlUpdate.value}${window.location.hash || ''}`;
          console.log(`📊 Computed footnote URL for new entry: ${pendingUrlOverride}`);
        } else {
          // Hash-based URL (for hypercites, highlights, citations)
          const segments = window.location.pathname.split('/').filter(Boolean);
          const cleanPath = `/${segments[0] || ''}`;
          pendingUrlOverride = `${cleanPath}#${urlUpdate.value}`;
          console.log(`📊 Computed hash URL for new entry: ${pendingUrlOverride}`);
        }
      } else if (anchorId) {
        // Multi/overlapping content: no single canonical hash, but anchor the new history entry
        // on the exact clicked element so Back doesn't inherit a stale hash from the address bar.
        const segments = window.location.pathname.split('/').filter(Boolean);
        pendingUrlOverride = `/${segments[0] || ''}#${anchorId}`;
        console.log(`📊 Computed multi-content anchor URL for new entry: ${pendingUrlOverride}`);
      } else {
        console.log(`📊 Multi-content: no URL change needed`);
      }

      // Write any non-URL state changes (e.g. hyperlitContainer metadata)
      // into the CURRENT entry so legacy restoration paths can still find
      // them — but DON'T touch the URL. The URL change is deferred to the
      // pushState below.
      history.replaceState(newState, '');
    }

    // =========================================================================
    // EDIT MODE: Auto-enable for newly created items
    // =========================================================================
    const hasJustCreatedItem = isNewFootnote || (newHighlightIds && newHighlightIds.length > 0);
    if (hasJustCreatedItem && !isBackNavigation && !options.brainModeHighlightId) {
      console.log('✏️ Just-created item detected, auto-enabling edit mode');
      setHyperlitEditMode(true);
    }

    // Get current edit mode state
    const editModeEnabled = getHyperlitEditMode();
    console.log(`✏️ Edit mode enabled: ${editModeEnabled}`);

    // 🚀 PERFORMANCE: Build content FIRST so highlight caches are warm for permission check
    const unifiedContent: any = await buildUnifiedContent(contentTypes, newHighlightIds, db, editModeEnabled);

    // Check if user has permission to edit ANY item (determines if edit button shows)
    // Uses cached highlightOwnership from buildHighlightContent when available
    const hasAnyEditPermission = isNewFootnote || await checkIfUserHasAnyEditPermission(contentTypes, newHighlightIds, db);
    console.log(`✏️ User has edit permission: ${hasAnyEditPermission}`);

    console.log(`📦 Built unified content (${unifiedContent.length} chars)`);

    // Apply cascade-origin glow to the source highlight (persists while container
    // is open). A highlight renders as MULTIPLE sibling marks (split by overlaps
    // and footnote sups) — glow the whole group sharing the clicked mark's HL_*
    // classes, not just the clicked fragment, so the glow matches the actual
    // highlighted text.
    if (element && element.tagName === 'MARK') {
      const { getHighlightIdsFromMark, getMarkGroup }: any = await import('../hyperlights/markGroup');
      document.querySelectorAll('.cascade-origin').forEach((el: any) => el.classList.remove('cascade-origin'));
      const groupMarks = getMarkGroup(element);
      (groupMarks.length > 0 ? groupMarks : [element]).forEach((m: any) => m.classList.add('cascade-origin'));
      // Fire-and-forget: persist cascade-origin ID for chunk re-renders
      // (dynamic import avoids circular dependency with scrolling)
      const hlId = getHighlightIdsFromMark(element)[0];
      if (hlId) {
        import('../scrolling/index').then(({ setCascadeOriginId }: any) => setCascadeOriginId(hlId));
      }
    }

    // Capture main edit state BEFORE opening container.
    // Needed for ALL content types (including read-only citations)
    // so cleanupContainerListeners() correctly restores the toolbar.
    const { isEditorObserving }: any = await import('../divEditor/index');
    if (!containerState.mainEditorWasActive) containerState.mainEditorWasActive = isEditorObserving();
    containerState.previousIsEditing = (window as any).isEditing;

    // Guard: suppress main observer during container open to prevent
    // DOM side-effects (CSS class changes, layout reflows) from triggering
    // false save signals on the main content.
    const mainObserverWasActive = containerState.mainEditorWasActive;
    if (mainObserverWasActive) {
      const { setProgrammaticUpdateInProgress }: any = await import('../utilities/operationState');
      setProgrammaticUpdateInProgress(true);
    }

    // All content types: prepare off-screen → load → animate in.
    // This avoids the "open empty then expand" jank since content may be a
    // skeleton until the async sub-book loads.
    prepareHyperlitContainer(unifiedContent, isBackNavigation);
    const baseContainerEl = document.getElementById('hyperlit-container');
    await handlePostOpenActions(contentTypes, newHighlightIds, focusPreserver, isNewFootnote, hasAnyEditPermission, false, db, { ...options, containerEl: baseContainerEl });
    animateHyperlitContainerOpen();

    // Release the guard after container open is complete
    if (mainObserverWasActive) {
      const { setProgrammaticUpdateInProgress }: any = await import('../utilities/operationState');
      setProgrammaticUpdateInProgress(false);
    }

    // --- Push layer 0 into the stack so layers[] always tracks all open containers ---
    {
      const { pushLayer, syncStackToHistoryState, isEmpty: isStackEmpty }: any = await import('./stack.js');

      // Build containerState for serialization (reuse the one we already built for history.state,
      // or build a fresh one if skipUrlUpdate skipped that block)
      const layerContainerState = {
        contentTypes: contentTypes.map((ct: any) => ({
          type: ct.type,
          hyperciteId: ct.hyperciteId,
          highlightIds: ct.highlightIds,
          fnCountId: ct.fnCountId,
          elementId: ct.elementId,
          footnoteId: ct.footnoteId,
          referenceId: ct.referenceId,
          relationshipStatus: ct.relationshipStatus,
          parentBookId: ct.parentBookId || null,
          // hypercite-citation fields
          targetBook: ct.targetBook || null,
          targetHyperciteId: ct.targetHyperciteId || null,
          targetUrl: ct.targetUrl || null,
          isHyperlightURL: ct.isHyperlightURL || false,
          isFootnoteURL: ct.isFootnoteURL || false,
          hlDepth: ct.hlDepth || 0,
        })),
        anchorId,
        newHighlightIds,
        timestamp: Date.now()
      };

      // Only push if stack is empty (avoid double-push on back navigation restores)
      if (isStackEmpty()) {
        pushLayer({
          depth: 0,
          container: document.getElementById('hyperlit-container'),
          overlay: document.getElementById('ref-overlay'),
          scroller: document.querySelector('#hyperlit-container .scroller'),
          isDynamic: false,
          savedModuleState: null,   // filled when stacking happens
          savedSubBookState: null,
          savedEditMode: getHyperlitEditMode(),
          contentMetadata: layerContainerState,
        });
        // Fresh open: push a new history entry so browser back unwinds the
        // open as its own step (rather than collapsing it into the prior
        // entry's state, which would destroy the "book with nothing open"
        // identity). Pass the URL we computed earlier so the *new* entry
        // gets the footnote/hash path, while the previous entry (the
        // book-empty state) keeps its original clean URL.
        syncStackToHistoryState({
          pushHistoryEntry: !isBackNavigation,
          urlOverride: pendingUrlOverride,
        });
      }
    }

  } catch (error) {
    console.error("❌ Error in unified content handler:", error);
  } finally {
    // Clean up focus preserver if it wasn't used (e.g., not a footnote after all)
    if (focusPreserver && focusPreserver.parentNode) {
      focusPreserver.remove();
    }
    // Reset the processing flag immediately (no delay needed)
    containerState.isProcessingClick = false;
    console.log("🔄 Reset containerState.isProcessingClick flag");
  }
}



// ============================================================================
// STACKED LAYER PUSH
// ============================================================================

/**
 * Push a new stacked container layer when a click originates from inside
 * an existing hyperlit container.
 */
async function pushStackedLayer(element: any, highlightIds: any, newHighlightIds: any, skipUrlUpdate: any, directHyperciteId: any, isNewFootnote: any, options: any = {}) {
  const {
    pushLayer, getDepth, getTopLayer, createStackedContainerDOM,
    getCurrentContainer: getContainer, getCurrentScroller: getScroller,
  }: any = await import('./stack.js');
  const { getHyperlitEditMode, setHyperlitEditMode }: any = await import('./core.js');
  const { detachNoteListeners }: any = await import('./noteListener.js');

  const currentDepth = getDepth();

  // --- 1. Pause current layer: flush saves, stop editor, detach listeners ---
  const { flushInputDebounce, flushAllPendingSaves }: any = await import('../divEditor/index');
  flushInputDebounce();
  await flushAllPendingSaves();

  const { getActiveEditSession }: any = await import('../divEditor/editSessionManager');
  const activeSession = getActiveEditSession();
  if (activeSession && activeSession.containerId !== 'main-content') {
    const { stopObserving }: any = await import('../divEditor/index');
    await stopObserving();
  }

  detachNoteListeners();

  // Save preview_nodes for current layer's sub-books before pausing them
  const { savePreviewNodes }: any = await import('./core.js');
  await savePreviewNodes();

  // --- 2. Snapshot module state ---
  const savedModuleState = saveModuleState();
  const savedSubBookState = saveSubBookState();
  const savedEditMode = getHyperlitEditMode();

  // Clear sub-book state for the fresh layer — Level 1's entries are saved above
  resetSubBookState();

  // --- 3. Push/update saved state on the stack ---
  const currentContainer = getContainer();
  const currentScroller = getScroller();

  let updatedExistingEntry = false;
  const topLayer = getTopLayer();

  if (topLayer && topLayer.savedModuleState === null) {
    // Active layer already has a stack entry — update its saved state
    topLayer.savedModuleState = savedModuleState;
    topLayer.savedSubBookState = savedSubBookState;
    topLayer.savedEditMode = savedEditMode;
    updatedExistingEntry = true;
  } else {
    // First stacked open — push base layer entry
    const currentOverlay = currentDepth === 0
      ? document.getElementById('ref-overlay')
      : currentContainer?.previousElementSibling;

    pushLayer({
      depth: currentDepth,
      container: currentContainer,
      overlay: currentOverlay,
      scroller: currentScroller,
      isDynamic: currentDepth > 0,
      savedModuleState,
      savedSubBookState,
      savedEditMode,
      contentMetadata: history.state?.hyperlitContainer || null,
    });
  }

  // Disable pointer events on the now-lower layer
  if (currentContainer) {
    currentContainer.style.pointerEvents = 'none';
  }

  // --- 4. Reset module state for the new layer ---
  resetModuleState();

  // Reset edit mode for fresh layer (inherits from parent)
  setHyperlitEditMode(savedEditMode);

  // --- 5. Create new DOM elements ---
  const newDepth = getDepth();
  const { container: newContainer, overlay: newOverlay, scroller: newScroller } = createStackedContainerDOM(newDepth);

  // Attach overlay click handler. Closing should consume the history
  // entry that opening this layer pushed — call history.back() so the
  // popstate handler's fast-path peels the top layer in DOM. Flush saves
  // first so nothing in flight is lost.
  newOverlay.addEventListener('click', async (e: any) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      const { flushInputDebounce, flushAllPendingSaves }: any = await import('../divEditor/index');
      flushInputDebounce();
      await flushAllPendingSaves();
    } catch (err) {
      console.warn('Pre-back flush failed for stacked overlay (non-fatal):', err);
    }
    history.back();
  });

  // Push the new layer entry (representing the active layer)
  // We don't push it yet — it's the "current" layer, stored implicitly.
  // The stack stores paused layers below. But we need an entry so
  // getCurrentContainer() returns the new container.
  pushLayer({
    depth: newDepth,
    container: newContainer,
    overlay: newOverlay,
    scroller: newScroller,
    isDynamic: true,
    savedModuleState: null, // will be filled when this layer is paused
    savedSubBookState: null,
    savedEditMode: savedEditMode,
  });

  // --- 6. Run normal content pipeline into the new container ---
  const db: any = await openDatabase();
  const contentTypes: any = await detectContentTypes(element, highlightIds, directHyperciteId, db);

  if (contentTypes.length === 0) {
    console.warn('📚 No content detected for stacked layer, aborting');
    const { popLayer: popRaw, removeStackedContainerDOM }: any = await import('./stack.js');
    popRaw(); // remove the new active layer

    if (updatedExistingEntry) {
      // Undo the in-place update — restore the entry to its "active" null state
      topLayer.savedModuleState = null;
      topLayer.savedSubBookState = null;
    } else {
      popRaw(); // remove the pushed paused entry
    }

    removeStackedContainerDOM(newContainer, newOverlay);
    restoreModuleState(savedModuleState);
    restoreSubBookState(savedSubBookState);
    if (currentContainer) currentContainer.style.pointerEvents = '';
    return;
  }

  // Check edit permissions
  const hasAnyEditPermission: any = await checkIfUserHasAnyEditPermission(contentTypes, newHighlightIds, db);
  const editModeEnabled = getHyperlitEditMode();

  // Build content HTML
  const unifiedContent: any = await buildUnifiedContent(contentTypes, newHighlightIds, db, editModeEnabled);

  // Set content into the new container's scroller
  newScroller.innerHTML = unifiedContent;

  // Set max-height dynamically
  const viewportHeight = window.innerHeight;
  newContainer.style.maxHeight = `${viewportHeight - 16 - 4}px`;

  // Lock body scroll (should already be locked from base layer, but ensure)
  document.body.classList.add('hyperlit-container-open');

  // Footnotes use deferred animation: load sub-book content first, then animate in.
  // This avoids the "open empty then expand" jank.
  const isFootnoteStacked = contentTypes.some((ct: any) => ct.type === 'footnote');

  if (isFootnoteStacked) {
    // Load content while container is off-screen
    await handlePostOpenActions(contentTypes, newHighlightIds, null, isNewFootnote, hasAnyEditPermission, false, null, { ...options, containerEl: newContainer });

    // Now animate the container in at full height
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        newContainer.classList.add('open');
      });
    });
  } else {
    // Non-footnote: animate immediately, then load content
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        newContainer.classList.add('open');
      });
    });

    await handlePostOpenActions(contentTypes, newHighlightIds, null, isNewFootnote, hasAnyEditPermission, false, null, { ...options, containerEl: newContainer });
  }

  // Set contentMetadata on the new stacked layer for serialization
  const stackedContainerState = {
    contentTypes: contentTypes.map((ct: any) => ({
      type: ct.type,
      hyperciteId: ct.hyperciteId,
      highlightIds: ct.highlightIds,
      fnCountId: ct.fnCountId,
      elementId: ct.elementId,
      footnoteId: ct.footnoteId,
      referenceId: ct.referenceId,
      relationshipStatus: ct.relationshipStatus,
      parentBookId: ct.parentBookId || null,
      // hypercite-citation fields
      targetBook: ct.targetBook || null,
      targetHyperciteId: ct.targetHyperciteId || null,
      targetUrl: ct.targetUrl || null,
      isHyperlightURL: ct.isHyperlightURL || false,
      isFootnoteURL: ct.isFootnoteURL || false,
      hlDepth: ct.hlDepth || 0,
    })),
    newHighlightIds,
    timestamp: Date.now()
  };
  const topNow = getTopLayer();
  if (topNow) topNow.contentMetadata = stackedContainerState;

  console.log(`📚 Stacked layer ${newDepth} opened successfully`);

  // --- 7. Update URL to reflect the new chain segment ---
  // Same pattern as the layer-0 callsite: COMPUTE the URL here but DO NOT
  // replaceState on it. The URL change is part of the *new* history entry
  // that the pushState below creates — applying it to the previous entry
  // would overwrite the parent layer's URL (destroying its identity for
  // browser back).
  let stackedPendingUrlOverride: any = null;
  if (!skipUrlUpdate) {
    const urlUpdate = determineSingleContentHash(contentTypes);
    if (urlUpdate) {
      // Save current URL on the layer below so popTopLayer can restore it
      const { getLayerBelow }: any = await import('./stack.js');
      const layerBelow = getLayerBelow();
      if (layerBelow) {
        layerBelow.savedUrl = window.location.pathname + window.location.search + window.location.hash;
      }

      // Find parent book from the source element's closest sub-book container
      const parentBookEl = element?.closest('[data-book-id]');
      const parentBook = parentBookEl
        ? parentBookEl.getAttribute('data-book-id')
        : (document.querySelector('.main-content')?.id || window.location.pathname.split('/').filter(Boolean)[0]);

      const subBookId = buildSubBookId(parentBook, urlUpdate.value);

      // Single-content stacked layer — URL is the sub-book path
      stackedPendingUrlOverride = '/' + subBookId;
      console.log(`📚 Computed sub-book URL for new entry: ${stackedPendingUrlOverride}`);
    } else {
      // Multi-content in stacked layer — save URL on layer below (containerStack handles restoration)
      const { getLayerBelow }: any = await import('./stack.js');
      const layerBelow = getLayerBelow();
      if (layerBelow) {
        layerBelow.savedUrl = window.location.pathname + window.location.search + window.location.hash;
      }
      console.log(`📚 Multi-content in stacked layer: stored in containerStack`);
    }
  }

  // Sync the full stack to history.state. This is the end of pushing a
  // stacked layer (i.e., a fresh container open on top of an existing
  // stack), so create a new history entry. Pass the computed URL so the
  // new entry carries the sub-book path and the parent entry keeps its
  // original URL untouched.
  const { syncStackToHistoryState }: any = await import('./stack.js');
  syncStackToHistoryState({
    pushHistoryEntry: true,
    urlOverride: stackedPendingUrlOverride,
  });
}



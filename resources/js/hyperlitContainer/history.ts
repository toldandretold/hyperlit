/**
 * History & Navigation Management
 * Handles URL hashes and browser history for hyperlit container state
 */

import { detectHypercites, detectHighlights } from './detection.js';
import { resetSubBookState, saveSubBookState } from './subBookActions';
import { buildUnifiedContent } from './contentBuild';
import { handlePostOpenActions } from './postOpen';
import { checkIfUserHasAnyEditPermission } from './permissions';
import { prepareHyperlitContainer, animateHyperlitContainerOpen, hyperlitManager, getHyperlitEditMode } from './core.js';
import { openDatabase } from '../indexedDB/index';
import { getCurrentContainer } from './stack.js';

/**
 * Determine URL update for single content types
 * Returns null for multiple content types (overlapping content)
 * @param {Array} contentTypes - Array of content type objects
 * @returns {Object|null} { type: 'hash'|'path', value: string, hash?: string } or null
 */
export function determineSingleContentHash(contentTypes: any) {
  if (contentTypes.length !== 1) {
    return null; // Multiple content types - don't update URL
  }

  const contentType = contentTypes[0];

  switch (contentType.type) {
    case 'hypercite':
      if (contentType.hyperciteId) {
        // Remove hypercite_ prefix if present, then add it back for consistency
        const cleanId = contentType.hyperciteId.replace(/^hypercite_/, '');
        return { type: 'hash', value: `hypercite_${cleanId}` };
      }
      break;

    case 'highlight':
      if (contentType.highlightIds && contentType.highlightIds.length === 1) {
        return { type: 'hash', value: contentType.highlightIds[0] }; // Already has HL_ prefix
      }
      break;

    case 'footnote':
      if (contentType.elementId || contentType.footnoteId) {
        // Footnotes use path-based URLs: /book/footnoteID
        // Hash portion is reserved for hypercite within footnote: /book/footnoteID#hyperciteID
        // detectFootnote() returns footnoteId; direct-ID detection uses elementId — support both
        return { type: 'path', value: contentType.elementId || contentType.footnoteId };
      }
      break;

    case 'citation':
      if (contentType.referenceId) {
        return { type: 'hash', value: `citation_${contentType.referenceId}` };
      }
      break;

    case 'hypercite-citation':
      if (contentType.element?.id) {
        return { type: 'hash', value: contentType.element.id };
      }
      break;
  }

  return null;
}

/**
 * Pick the single in-this-book element id a container should scroll the reader back to, from its
 * content types — precise-element first, so we land on the exact thing the user clicked (which, in
 * an overlap, is by definition INSIDE the overlapping hypercite/highlight). Runs on the LIVE
 * content types at open time (so it can read each detected type's `.element`, e.g. the clicked
 * hypercite-citation arrow's own id) and the result is stored as the layer's `anchorId`.
 *
 * Priority:
 *   1. footnote               — the Fn sup (footnoteId / elementId)
 *   2. hypercite-citation     — the clicked <a> arrow's OWN id (NOT targetHyperciteId, which is the
 *                               cross-book DESTINATION and can't resolve in THIS book)
 *   3. citation               — citation_<referenceId>
 *   4. hypercite SOURCE       — the <u> (hyperciteId); more likely the linked-from thing than a HL
 *   5. hyperlight             — highlightIds[0] (HL_…)
 * All of these resolve in the DOM via `findRenderedTarget` (scrolling/internalNav).
 *
 * @param {Array} contentTypes - live content type objects (from detection)
 * @returns {string|null} the anchor element id or null
 */
export function pickAnchorId(contentTypes: any[]): string | null {
  if (!contentTypes?.length) return null;
  const byType = (t: string) => contentTypes.find((ct: any) => ct?.type === t);

  const fn = byType('footnote');
  if (fn) {
    const id = fn.footnoteId || fn.elementId;
    if (id) return id;
  }

  const hcCite = byType('hypercite-citation');
  if (hcCite?.element?.id) return hcCite.element.id;

  const cite = byType('citation');
  if (cite?.referenceId) return `citation_${cite.referenceId}`;

  const hc = byType('hypercite');
  if (hc?.hyperciteId) return hc.hyperciteId;

  const hl = byType('highlight');
  if (Array.isArray(hl?.highlightIds) && hl.highlightIds[0]) return hl.highlightIds[0];

  return null;
}

/**
 * Derive the MAIN-PAGE anchor id a restored container is associated with — the hypercite /
 * highlight / footnote / citation element in the reader's main text. Used to scroll the reader
 * to the anchor when a container is restored (back/forward/refresh), since the container opens
 * OVER the main page and the restore URL usually carries only `?cs=N` (no hash) to drive it.
 *
 * Prefers the layer's stored `anchorId` (computed via `pickAnchorId` at open time — the exact
 * element the user clicked). Falls back to the legacy `determineSingleContentHash` + first-type
 * mapping for history entries written before `anchorId` was stored.
 * @param {Object} contentMetadata - a stack layer's serialized contentMetadata
 * @returns {string|null} the anchor element id (e.g. `hypercite_x`, `HL_x`, a footnote id) or null
 */
export function deriveMainAnchorId(contentMetadata: any): string | null {
  if (contentMetadata?.anchorId) return contentMetadata.anchorId;

  const types = contentMetadata?.contentTypes;
  if (!types?.length) return null;

  const single = determineSingleContentHash(types);
  if (single?.value) return single.value;

  // Legacy multi/overlapping content (no stored anchorId) — anchor on the first type's main id.
  const ct = types[0] || {};
  return ct.hyperciteId
    || (Array.isArray(ct.highlightIds) ? ct.highlightIds[0] : null)
    || ct.elementId
    || ct.footnoteId
    || ct.referenceId
    || ct.element?.id
    || null;
}

/**
 * Build content from serialized containerState metadata.
 * Re-fetches content types from IndexedDB, checks edit permissions,
 * and builds the unified HTML. Shared by all restoration paths.
 *
 * @param {Object} containerState - Serialized container state with contentTypes array
 * @returns {Promise<{html: string, contentTypes: Array, newHighlightIds: Array, hasAnyEditPermission: boolean}|null>}
 */
export async function buildContentFromMetadata(containerState: any) {
  if (!containerState?.contentTypes?.length) return null;

  // Reconstruct content types from stored state
  const contentTypes = [];

  for (const storedType of containerState.contentTypes) {
    let contentType = { ...storedType };

    // For hypercites, we might need to refetch some data
    if (storedType.type === 'hypercite' && storedType.hyperciteId) {
      const hyperciteData: any = await detectHypercites(null, storedType.hyperciteId);
      if (hyperciteData) {
        contentType = hyperciteData;
      }
    }

    // For highlights, refetch if we have IDs
    if (storedType.type === 'highlight' && storedType.highlightIds) {
      const highlightData: any = await detectHighlights(null, storedType.highlightIds);
      if (highlightData) {
        contentType = highlightData;
      }
    }

    contentTypes.push(contentType);
  }

  if (contentTypes.length === 0) return null;

  const db: any = await openDatabase();
  const newHighlightIds = containerState.newHighlightIds || [];
  const editModeEnabled = getHyperlitEditMode();
  const hasAnyEditPermission: any = await checkIfUserHasAnyEditPermission(contentTypes, newHighlightIds, db);

  const html: any = await buildUnifiedContent(contentTypes, newHighlightIds, db, editModeEnabled, hasAnyEditPermission);

  return { html, contentTypes, newHighlightIds, hasAnyEditPermission };
}

/**
 * Restore hyperlit container from history state (layer 0).
 * After opening, pushes layer 0 into the stack.
 *
 * @param {Object} providedContainerState - Optional container state (if not provided, reads from history.state)
 * @param {boolean} skipUrlUpdate - Whether to skip URL hash update (used when toggling edit mode)
 * @param {boolean} skipAutoFocus - Skip auto-focus (used when edit button handles focus separately)
 * @returns {Promise<boolean>} True if successfully restored
 */
export async function restoreHyperlitContainerFromHistory(providedContainerState: any = null, skipUrlUpdate: any = false, skipAutoFocus: any = false) {
  // Use provided state or fall back to history.state
  let containerState = providedContainerState;

  if (!containerState) {
    const historyState = history.state;
    if (!historyState || !historyState.hyperlitContainer) {
      console.log('📊 No hyperlit container state found in history');
      return false;
    }
    containerState = historyState.hyperlitContainer;
  }
  console.log('📊 Restoring hyperlit container from history:', containerState);

  try {
    const result: any = await buildContentFromMetadata(containerState);
    if (!result) return false;

    const { html, contentTypes, newHighlightIds, hasAnyEditPermission } = result;

    // Two-phase open: prepare off-screen → load content → animate in
    prepareHyperlitContainer(html, true); // isBackNavigation = true
    const baseContainerEl = document.getElementById('hyperlit-container');
    await handlePostOpenActions(contentTypes, newHighlightIds, null, false, hasAnyEditPermission, skipAutoFocus, null, { containerEl: baseContainerEl });
    animateHyperlitContainerOpen();

    // Push layer 0 into the stack
    const { pushLayer, syncStackToHistoryState, isEmpty: isStackEmpty }: any = await import('./stack.js');
    if (isStackEmpty()) {
      pushLayer({
        depth: 0,
        container: document.getElementById('hyperlit-container'),
        overlay: document.getElementById('ref-overlay'),
        scroller: document.querySelector('#hyperlit-container .scroller'),
        isDynamic: false,
        savedModuleState: null,
        savedSubBookState: null,
        savedEditMode: getHyperlitEditMode(),
        contentMetadata: containerState,
      });
      syncStackToHistoryState();
    }

    console.log('✅ Successfully restored hyperlit container from history');
    return true;
  } catch (error) {
    console.error('❌ Error restoring hyperlit container from history:', error);
  }

  return false;
}

/**
 * Restore a single stacked layer from serialized metadata.
 * Mirrors pushStackedLayer but builds content from metadata instead of a clicked element.
 *
 * @param {Object} containerState - Serialized container state for this layer
 * @returns {Promise<boolean>} True if successfully restored
 */
export async function restoreStackedLayer(containerState: any) {
  if (!containerState?.contentTypes?.length) return false;

  try {
    const {
      pushLayer, getDepth, getTopLayer,
      createStackedContainerDOM, syncStackToHistoryState,
      getCurrentContainer: getContainer, getCurrentScroller: getScroller,
    }: any = await import('./stack.js');
    const { setHyperlitEditMode }: any = await import('./core.js');
    const { detachNoteListeners }: any = await import('./noteListener.js');
    const {
      saveModuleState, restoreModuleState, resetModuleState,
    }: any = await import('./containerState');

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

    // --- 2. Snapshot module state ---
    const savedModuleState = saveModuleState();
    const savedSubBookState = saveSubBookState();
    const savedEditMode = getHyperlitEditMode();

    resetSubBookState();

    // --- 3. Update saved state on the current top layer ---
    const currentContainer = getContainer();
    const topLayer = getTopLayer();
    if (topLayer && topLayer.savedModuleState === null) {
      topLayer.savedModuleState = savedModuleState;
      topLayer.savedSubBookState = savedSubBookState;
      topLayer.savedEditMode = savedEditMode;
    }

    // Disable pointer events on the now-lower layer
    if (currentContainer) {
      currentContainer.style.pointerEvents = 'none';
    }

    // --- 4. Reset module state for the new layer ---
    resetModuleState();
    setHyperlitEditMode(savedEditMode);

    // --- 5. Create new DOM elements ---
    const newDepth = getDepth();
    const { container: newContainer, overlay: newOverlay, scroller: newScroller } = createStackedContainerDOM(newDepth);

    // Attach overlay click handler. Closing should consume the history
    // entry that opening this layer pushed — call history.back() so the
    // popstate handler's fast-path peels the top layer in DOM. Flush
    // saves first so nothing in flight is lost.
    newOverlay.addEventListener('click', async (e: any) => {
      e.stopPropagation();
      e.preventDefault();
      try {
        const { flushInputDebounce, flushAllPendingSaves }: any = await import('../divEditor/index');
        flushInputDebounce();
        await flushAllPendingSaves();
      } catch (err) {
        console.warn('Pre-back flush failed for restored stacked overlay (non-fatal):', err);
      }
      history.back();
    });

    // Push the new layer entry
    pushLayer({
      depth: newDepth,
      container: newContainer,
      overlay: newOverlay,
      scroller: newScroller,
      isDynamic: true,
      savedModuleState: null,
      savedSubBookState: null,
      savedEditMode: savedEditMode,
      contentMetadata: containerState,
    });

    // --- 6. Build content from metadata and render ---
    const result: any = await buildContentFromMetadata(containerState);
    if (!result) {
      console.warn('📚 No content built for stacked layer restore, aborting');
      return false;
    }

    const { html, contentTypes, newHighlightIds, hasAnyEditPermission } = result;
    newScroller.innerHTML = html;

    // Set max-height dynamically
    const viewportHeight = window.innerHeight;
    newContainer.style.maxHeight = `${viewportHeight - 16 - 4}px`;

    // Lock body scroll
    document.body.classList.add('hyperlit-container-open');

    // Animate the container open
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        newContainer.classList.add('open');
      });
    });

    // Handle post-open actions
    await handlePostOpenActions(contentTypes, newHighlightIds, null, false, hasAnyEditPermission, true, null, { containerEl: newContainer });

    // Sync stack to history.state
    syncStackToHistoryState();

    console.log(`📚 Stacked layer ${newDepth} restored successfully`);
    return true;
  } catch (error) {
    console.error('❌ Error restoring stacked layer:', error);
    return false;
  }
}

/**
 * Restore an entire container stack from serialized data.
 * Single entry point for all restoration (popstate, refresh, SPA transition).
 *
 * @param {Array} stack - Array of serialized layer objects from history.state.containerStack
 * @param {Object} [opts]
 * @param {string} [opts.callsite] - Free-form label naming the caller. Logged
 *   with the restoration's pre-flight decisions so a forensic trace of who
 *   tried to restore (and whether the guard accepted) is visible in the
 *   browser console without grepping multiple files.
 * @returns {Promise<boolean>} True if successfully restored
 */
export async function restoreContainerStack(stack: any, opts: any = {}) {
  const callsite = opts.callsite || 'unknown';

  if (!stack?.length) {
    console.log(`📚 [${callsite}] restoreContainerStack noop — empty stack`);
    return false;
  }

  // ── Guard: only restore onto the same book the stack was saved for ──
  // The `book` global lags behind URL changes during cross-page popstates
  // (book→home), so checking it directly produced false positives that let
  // stale stacks be restored onto home. Use the actually-rendered reader
  // main element as the source of truth — it's set server-side from the
  // canonical $book id (URL-agnostic re slugs vs ids).
  //   reader.blade.php: <main class="main-content" id="{{ $book }}" data-slug="…" ...>
  //   home.blade.php:   <main class="main-content active-content" id="most-recent"> (no data-slug)
  //   user.blade.php:   <main class="main-content active-content" id="…"> (no data-slug)
  // The reader's id is NOT always `book_<digits>` — canonical / vanity books have a SLUG id
  // (e.g. `bedjaouinieo`). An `id^="book_"` guard skipped container-stack restore for those,
  // landing the user at the top. `[data-slug]` (emitted only by reader.blade) matches book_ AND
  // slug readers and excludes home/user.
  const readerMain = typeof document !== 'undefined'
    ? document.querySelector('main.main-content[data-slug]')
    : null;
  const renderedBookId = readerMain?.id || null;
  const savedBookId = stack[0]?.contentMetadata?.bookId
    || history.state?.containerStackBookId
    || null;

  if (!renderedBookId) {
    console.log(`📚 [${callsite}] restoreContainerStack SKIPPED — current page is not a reader (no main.main-content[data-slug]). savedBookId=${savedBookId}, layers=${stack.length}`);
    return false;
  }
  if (savedBookId && savedBookId !== renderedBookId) {
    console.log(`📚 [${callsite}] restoreContainerStack SKIPPED — saved bookId "${savedBookId}" does not match rendered "${renderedBookId}". layers=${stack.length}`);
    return false;
  }

  console.log(`📚 [${callsite}] restoreContainerStack START — ${stack.length} layers onto ${renderedBookId} (saved=${savedBookId || 'legacy/none'})`);

  // Layer 0: restore via existing path (opens base container + pushes layer 0)
  const restored: any = await restoreHyperlitContainerFromHistory(stack[0].contentMetadata);
  if (!restored) {
    console.log(`📚 [${callsite}] restoreContainerStack FAILED — layer 0 did not restore`);
    return false;
  }

  // Scroll the MAIN reader to the element this container is anchored to (the hypercite/highlight/
  // footnote in the main text). The container opens OVER the main page; without this the reader is
  // left wherever the fresh load landed (usually the TOP) with a container hovering over unrelated
  // content. The restore URL carries only `?cs=N` (no hash) on most restores, so the old hash-gated
  // scroll in the popstate handler never fired — derive the anchor from the SAME metadata the
  // container was built from instead. Fire-and-forget: navigateToInternalId sets
  // isNavigatingToInternalId, which restoreScrollPosition bails on, so this wins the scroll.
  try {
    const anchorId = deriveMainAnchorId(stack[0]?.contentMetadata);
    if (anchorId) {
      const { currentLazyLoader }: any = await import('../pageLoad/currentLazyLoaderState');
      if (currentLazyLoader) {
        const { navigateToInternalId }: any = await import('../scrolling/index');
        console.log(`📚 [${callsite}] restoreContainerStack scrolling main to anchor "${anchorId}"`);
        navigateToInternalId(anchorId, currentLazyLoader, false);
      }
    }
  } catch (e) {
    console.warn(`📚 [${callsite}] restoreContainerStack: main-anchor scroll failed (non-fatal):`, e);
  }

  // Layers 1+: restore via direct stacking
  for (let i = 1; i < stack.length; i++) {
    // Wait for sub-book content to load before stacking the next layer
    await new Promise((r: any) => setTimeout(r, 300));
    const ok: any = await restoreStackedLayer(stack[i].contentMetadata);
    if (!ok) {
      console.warn(`📚 [${callsite}] restoreContainerStack stopped at layer ${i}`);
      break;
    }
  }

  console.log(`📚 [${callsite}] restoreContainerStack COMPLETE`);
  return true;
}

/**
 * Get current container state for preservation during navigation
 * Returns null if no container is open
 * @returns {Object|null} Current container state or null
 */
export async function getCurrentContainerState() {
  // Already imported statically

  if (!hyperlitManager || !getCurrentContainer()?.style.display ||
      getCurrentContainer().style.display === 'none') {
    return null;
  }

  // Try to extract state from current container content
  // This is a fallback method - ideally state should be tracked during opening
  const container = getCurrentContainer();
  if (!container) return null;

  // Return basic state (full implementation would extract more details)
  return {
    isOpen: true,
    timestamp: Date.now()
  };
}

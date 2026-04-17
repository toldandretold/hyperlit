/**
 * Hyperlit Container Stack Manager
 *
 * Manages a stack of hyperlit container layers for nested navigation.
 * Clicking a hyperlight/footnote/citation inside an already-open container
 * pushes a new layer on top instead of replacing it.
 */

import { book } from '../app.js';

// ============================================================================
// STACK DATA STRUCTURE
// ============================================================================

/**
 * Each layer in the stack stores:
 * @typedef {Object} StackLayer
 * @property {number} depth
 * @property {HTMLElement} container - DOM element
 * @property {HTMLElement} overlay - DOM element
 * @property {HTMLElement} scroller - .scroller inside container
 * @property {boolean} isDynamic - false for layer 0 (existing DOM), true for created layers
 * @property {Object} savedModuleState - snapshot from index.js saveModuleState()
 * @property {Map} savedSubBookState - snapshot from subBookLoader.js saveSubBookState()
 * @property {boolean} savedEditMode - isHyperlitEditMode for this layer
 */

const layers = [];

let isPopping = false;

export function isStackPopping() {
  return isPopping;
}

// Re-entrancy guard for saveAndPopTopLayer (prevents double-close)
let isPopPending = false;
export function isStackPopPending() { return isPopPending; }

const SHRINK_FACTOR = 0.98;    // each level is 98% of previous width
const LEVELS_PER_FLIP = 5;     // alternates gap side every 5 levels
let cachedBaseWidthPx = null;
let cachedBaseRightPx = null;

// ============================================================================
// CASCADE POSITIONING
// ============================================================================

/**
 * Read the base #hyperlit-container computed dimensions once and cache them.
 */
function getBaseContainerMetrics() {
  if (cachedBaseWidthPx !== null && cachedBaseRightPx !== null) {
    return { baseWidthPx: cachedBaseWidthPx, baseRightPx: cachedBaseRightPx };
  }

  const base = document.getElementById('hyperlit-container');
  if (base) {
    const rect = base.getBoundingClientRect();
    cachedBaseWidthPx = rect.width;  // width is NOT affected by translateX

    // Use getComputedStyle for right — getBoundingClientRect().right is
    // displaced by CSS transform transitions and returns wrong values mid-animation.
    // getComputedStyle().right returns the CSS layout value, unaffected by transform.
    const computedRight = parseFloat(getComputedStyle(base).right);
    cachedBaseRightPx = (!isNaN(computedRight) && computedRight >= 0)
      ? computedRight
      : (window.innerWidth - rect.right);
  } else {
    cachedBaseWidthPx = window.innerWidth * 0.6;
    cachedBaseRightPx = 12;
  }

  return { baseWidthPx: cachedBaseWidthPx, baseRightPx: cachedBaseRightPx };
}

/**
 * Calculate pixel-based cascade position for a given depth.
 *
 * Width resets every LEVELS_PER_FLIP levels — each group starts at 98% of
 * base and shrinks to 98^5 of base, then the next group resets to 98% again
 * but from the opposite side:
 *   - Even groups (0, 2, 4…): right edges aligned, gap grows on LEFT
 *   - Odd groups  (1, 3, 5…): left edges aligned, gap grows on RIGHT
 *
 * @param {number} depth
 * @returns {{ widthPx: number, rightPx: number }}
 */
function calculateCascadePosition(depth) {
  const { baseWidthPx, baseRightPx } = getBaseContainerMetrics();

  const group = Math.floor((depth - 1) / LEVELS_PER_FLIP);
  const localDepth = ((depth - 1) % LEVELS_PER_FLIP) + 1;
  const widthPx = baseWidthPx * Math.pow(SHRINK_FACTOR, localDepth);

  let rightPx;
  if (group % 2 === 0) {
    // Even group: right edge aligned with base, gap on LEFT
    rightPx = baseRightPx;
  } else {
    // Odd group: left edge aligned with base, gap on RIGHT
    rightPx = baseRightPx + baseWidthPx - widthPx;
  }

  return { widthPx, rightPx, group };
}

// ============================================================================
// STACK ACCESSORS
// ============================================================================

export function getDepth() {
  return layers.length;
}

export function getTopLayer() {
  return layers.length > 0 ? layers[layers.length - 1] : null;
}

export function getLayerBelow() {
  return layers.length >= 2 ? layers[layers.length - 2] : null;
}

export function isEmpty() {
  return layers.length === 0;
}

export function isStacked() {
  return layers.length > 1;
}

/**
 * Get the container element for the current (top) layer.
 * Falls back to the base #hyperlit-container if stack is empty.
 */
export function getCurrentContainer() {
  const top = getTopLayer();
  if (top) return top.container;
  return document.getElementById('hyperlit-container');
}

/**
 * Get the scroller element for the current (top) layer.
 */
export function getCurrentScroller() {
  const container = getCurrentContainer();
  return container?.querySelector('.scroller') ?? null;
}

// ============================================================================
// STACK MUTATIONS
// ============================================================================

export function pushLayer(layerData) {
  layers.push(layerData);
  console.log(`📚 Stack push → depth ${layers.length}`);
}

export function popLayer() {
  const popped = layers.pop();
  console.log(`📚 Stack pop → depth ${layers.length}`);
  return popped;
}

export function clear() {
  layers.length = 0;
  cachedBaseWidthPx = null;
  cachedBaseRightPx = null;
  console.log('📚 Stack cleared');
}

// ============================================================================
// DYNAMIC DOM CREATION
// ============================================================================

/**
 * Create overlay + container DOM elements for a stacked layer.
 *
 * @param {number} depth - The depth index (1-based for dynamic layers)
 * @returns {{ container: HTMLElement, overlay: HTMLElement, scroller: HTMLElement }}
 */
export function createStackedContainerDOM(depth) {
  // --- Overlay ---
  const overlay = document.createElement('div');
  overlay.className = 'hyperlit-overlay-stacked';
  overlay.setAttribute('data-layer', depth);
  // Interleaved z-index: overlays sit between containers
  // Layer 1 overlay: 1003 (between base container 1002 and stacked container 1004)
  overlay.style.zIndex = 1001 + (depth * 2);
  // First 2 overlays dim noticeably; deeper ones stay subtle
  // so page edges remain visible without compounding darkness
  const opacity = depth <= 2 ? 0.15 : 0.06;
  overlay.style.backgroundColor = `rgba(0, 0, 0, ${opacity})`;

  // --- Container ---
  const container = document.createElement('div');
  container.className = 'hyperlit-container-stacked';
  container.setAttribute('data-layer', depth);
  // Interleaved z-index: containers sit above their preceding overlay
  // Layer 1 container: 1004 (above overlay 1003)
  container.style.zIndex = 1002 + (depth * 2);

  // Pixel-based cascade: each level is 2% narrower, gap side alternates
  const { widthPx, rightPx, group } = calculateCascadePosition(depth);
  const { baseWidthPx, baseRightPx } = getBaseContainerMetrics();
  console.log(`📐 Cascade position for depth ${depth}: width=${widthPx}px, right=${rightPx}px (base: ${baseWidthPx}x${baseRightPx})`);
  container.style.width = `${widthPx}px`;
  container.style.right = `${rightPx}px`;
  // Shadow on the gap side: even groups gap left, odd groups gap right
  const shadowX = group % 2 === 0 ? -4 : 4;
  container.style.boxShadow = `${shadowX}px 0 12px rgba(0, 0, 0, 0.3)`;

  // Build inner structure matching #hyperlit-container
  container.innerHTML = `
    <div class="mask-top"></div>
    <div class="scroller"></div>
    <div class="mask-bottom"></div>
    <div class="container-controls">
      <div class="resize-handle resize-left"></div>
      <div class="drag-handle"></div>
      <div class="resize-handle resize-right"></div>
    </div>
  `;

  const scroller = container.querySelector('.scroller');

  // Set initial max-height same as base container logic
  const viewportHeight = window.innerHeight;
  const topMargin = 16;
  const bottomGap = 4;
  container.style.maxHeight = `${viewportHeight - topMargin - bottomGap}px`;

  // Append to body
  document.body.appendChild(overlay);
  document.body.appendChild(container);

  return { container, overlay, scroller };
}

/**
 * Remove dynamic DOM elements for a stacked layer.
 */
export function removeStackedContainerDOM(container, overlay) {
  container?.remove();
  overlay?.remove();
}

// ============================================================================
// STACK SERIALIZATION
// ============================================================================

/**
 * Serialize the stack to a plain array suitable for history.state.
 * Only stores metadata needed to rebuild layers — no DOM references.
 */
export function serializeStack() {
  if (layers.length === 0) return null;
  return layers.map(layer => ({
    depth: layer.depth,
    contentMetadata: layer.contentMetadata || null,
    savedUrl: layer.savedUrl || null,
    savedEditMode: layer.savedEditMode ?? false,
  }));
}

/**
 * Write the current stack state into history.state.
 * Also updates the URL with a ?cs=<depth> param so refresh/back-nav
 * know containers are open even if the URL path didn't change.
 * Called after every push/pop.
 */
export function syncStackToHistoryState() {
  const serialized = serializeStack();
  const depth = serialized?.length ?? 0;

  // Update URL with ?cs=<depth> marker (or strip it when stack is empty)
  const url = new URL(window.location.href);
  if (depth > 0) {
    url.searchParams.set('cs', String(depth));
  } else {
    url.searchParams.delete('cs');
  }
  const newUrl = url.pathname + url.search + url.hash;

  history.replaceState({
    ...history.state,
    containerStack: serialized,
    containerStackBookId: depth > 0 ? book : null,
    // Keep legacy field for backward compat
    hyperlitContainer: serialized?.length > 0
      ? serialized[serialized.length - 1].contentMetadata
      : null,
  }, '', newUrl);
  console.log(`📚 Stack synced to history.state (${depth} layers), URL: ${newUrl}`);
}

// ============================================================================
// SAVE-AND-POP (mirrors saveAndCloseHyperlitContainer for stacked layers)
// ============================================================================

/**
 * Close the topmost stacked layer with proper save semantics.
 * Mirrors saveAndCloseHyperlitContainer(): shows progress overlay, flushes
 * input debounce + save queue, saves preview_nodes, then pops the layer.
 *
 * In read mode, skips the save and pops immediately.
 */
export async function saveAndPopTopLayer() {
  if (isPopPending) {
    console.warn('saveAndPopTopLayer BLOCKED — already in flight');
    return;
  }
  isPopPending = true;

  try {
    const { getHyperlitEditMode } = await import('./core.js');

    if (!getHyperlitEditMode()) {
      // Read mode — just pop, no save needed
      return popTopLayer();
    }

    // Show progress overlay (same as saveAndCloseHyperlitContainer)
    const { ProgressOverlayConductor } = await import('../navigation/ProgressOverlayConductor.js');
    ProgressOverlayConductor.showSPATransition(50, 'Saving your changes...', true);

    try {
      // prepareContainerClose equivalent: flush + save preview_nodes
      const { flushInputDebounce, flushAllPendingSaves } = await import('../divEditor/index.js');
      flushInputDebounce();
      await flushAllPendingSaves();

      // Save preview_nodes for active sub-books (same as prepareContainerClose)
      const { savePreviewNodes } = await import('./core.js');
      await savePreviewNodes();

      ProgressOverlayConductor.updateProgress(100, 'Save complete');
      await new Promise(resolve => setTimeout(resolve, 150));
      await ProgressOverlayConductor.hide();

      // Now pop the layer (saves already flushed — popTopLayer's internal flush is a no-op)
      await popTopLayer();
    } catch (error) {
      console.error('Error during save-and-pop:', error);
      await ProgressOverlayConductor.hide();
      await popTopLayer(); // still try to pop even if save failed
    }
  } finally {
    isPopPending = false;
  }
}

// ============================================================================
// POP TOP LAYER (full lifecycle)
// ============================================================================

let popQueue = Promise.resolve();

/**
 * Close and clean up only the topmost stacked layer.
 * Restores the layer beneath it.
 * Queued so concurrent calls never overlap.
 */
export async function popTopLayer() {
  popQueue = popQueue.then(() => _popTopLayerImpl());
  return popQueue;
}

async function _popTopLayerImpl() {
  const top = getTopLayer();
  if (!top) return;

  console.log(`📚 Popping layer ${top.depth}...`);

  // Set flag FIRST to prevent handleSelection() from firing during flush
  isPopping = true;

  try {

  // Flush pending saves BEFORE clearing selection.
  // The debounced input handler uses window.getSelection() to locate the
  // target node — clearing ranges first makes the flush silently skip the save.
  const { flushInputDebounce, flushAllPendingSaves } = await import('../divEditor/index.js');
  flushInputDebounce();
  await flushAllPendingSaves();

  // NOW safe to clear selection (saves already captured)
  try {
    window.getSelection().removeAllRanges();
  } catch (_) {}
  const btns = document.getElementById('hyperlight-buttons');
  if (btns) btns.style.display = 'none';

  // 1. Detach noteListeners FIRST while DOM is still intact (flushes pending saves)
  const { detachNoteListeners } = await import('./noteListener.js');
  detachNoteListeners();

  // 2. Flush saves + cleanup on current layer (skip editor restore — layer below handles it)
  const { cleanupContainerListeners } = await import('./index.js');
  await cleanupContainerListeners({ stackPop: true });

  // 3. Now safe to destroy sub-books (saves already flushed)
  const { destroyAllSubBooks } = await import('./subBookLoader.js');
  await destroyAllSubBooks();

  // 4. Remove DOM elements for dynamic layers
  if (top.isDynamic) {
    removeStackedContainerDOM(top.container, top.overlay);
  }

  // 5. Pop from stack
  popLayer();

  // 6. If stack is now empty, do full close
  if (isEmpty()) {
    try {
      // Restore module state before full close
      const { restoreModuleState } = await import('./index.js');
      restoreModuleState(top.savedModuleState);

      const { restoreSubBookState } = await import('./subBookLoader.js');
      restoreSubBookState(top.savedSubBookState);
    } catch (err) {
      console.warn('Error restoring state during close (non-fatal):', err);
    }

    // Full close sequence — always reached even if restore above threw
    const { closeHyperlitContainer } = await import('./core.js');
    await closeHyperlitContainer();
    return;
  }

  // 7. Restore the layer below (now the new top)
  const newTop = getTopLayer();
  if (!newTop) return;

  // Restore module state + sub-book state (always needed, even during bulk close)
  const { restoreModuleState } = await import('./index.js');
  restoreModuleState(newTop.savedModuleState);

  const { restoreSubBookState } = await import('./subBookLoader.js');
  restoreSubBookState(newTop.savedSubBookState);

  // Reset saved state — this layer is now active, not paused.
  // pushStackedLayer uses savedModuleState === null to detect the active layer.
  newTop.savedModuleState = null;
  newTop.savedSubBookState = null;

  // Delay re-enabling pointer events by one frame to flush queued click events.
  // Without this, rapid overlay clicks pass through to the restored container content
  // (because the stacked overlay is gone), triggering handleMarkClick → pushStackedLayer.
  requestAnimationFrame(() => {
    if (newTop.container) newTop.container.style.pointerEvents = '';
  });

  // Apply the current global edit mode to the restored layer's DOM.
  // Skip during bulk close (closeHyperlitContainer unwinds the stack —
  // no need for heavyweight observer/toolbar work on each intermediate layer).
  const { isContainerClosing } = await import('./core.js');
  const closingNow = isContainerClosing();
  if (!closingNow) {
    const { applyCurrentEditModeToLayer } = await import('./index.js');
    await applyCurrentEditModeToLayer();
  }

  console.log(`📚 Layer ${newTop.depth} restored`);

  // Restore URL from the now-visible layer's saved state
  // Skip when closeHyperlitContainer is bulk-unwinding — it handles URL cleanup itself
  try {
    if (closingNow) {
      console.log('📚 URL restore + state sync skipped — container is closing (bulk unwind)');
    } else {
      if (newTop.savedUrl) {
        console.log(`📚 URL restore on pop: ${window.location.pathname} → ${newTop.savedUrl}`);
        history.replaceState(history.state, '', newTop.savedUrl);
      }
      // Sync stack to history.state after pop
      syncStackToHistoryState();
    }
  } catch (err) {
    console.warn('URL restore on pop failed (non-fatal):', err);
    syncStackToHistoryState(); // fallback: sync anyway if import failed
  }

  } finally {
    isPopping = false;
  }
}

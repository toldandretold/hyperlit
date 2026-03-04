/**
 * Hyperlit Container Stack Manager
 *
 * Manages a stack of hyperlit container layers for nested navigation.
 * Clicking a hyperlight/footnote/citation inside an already-open container
 * pushes a new layer on top instead of replacing it.
 */

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
    cachedBaseWidthPx = rect.width;
    cachedBaseRightPx = window.innerWidth - rect.right;
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

  return { widthPx, rightPx };
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
  // Progressive darkening: each layer adds more darkness
  // Depth 1: 0.15, Depth 2: 0.23, Depth 3: 0.31, etc.
  const opacity = 0.15 + ((depth - 1) * 0.08);
  overlay.style.backgroundColor = `rgba(0, 0, 0, ${Math.min(opacity, 0.5)})`;

  // --- Container ---
  const container = document.createElement('div');
  container.className = 'hyperlit-container-stacked';
  container.setAttribute('data-layer', depth);
  // Interleaved z-index: containers sit above their preceding overlay
  // Layer 1 container: 1004 (above overlay 1003)
  container.style.zIndex = 1002 + (depth * 2);

  // Pixel-based cascade: each level is 2% narrower, gap side alternates
  const { widthPx, rightPx } = calculateCascadePosition(depth);
  container.style.width = `${widthPx}px`;
  container.style.right = `${rightPx}px`;

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

  // 1. Flush saves + cleanup on current layer (skip editor restore — layer below handles it)
  const { cleanupContainerListeners } = await import('./index.js');
  await cleanupContainerListeners({ stackPop: true });

  const { destroyAllSubBooks } = await import('./subBookLoader.js');
  await destroyAllSubBooks();

  const { detachNoteListeners } = await import('./noteListener.js');
  detachNoteListeners();

  // 2. Remove DOM elements for dynamic layers
  if (top.isDynamic) {
    removeStackedContainerDOM(top.container, top.overlay);
  }

  // 3. Pop from stack
  popLayer();

  // 4. If stack is now empty, do full close
  if (isEmpty()) {
    try {
      // Restore edit mode from popped layer
      const { setHyperlitEditMode } = await import('./core.js');
      setHyperlitEditMode(top.savedEditMode);

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

  // 5. Restore the layer below (now the new top)
  const newTop = getTopLayer();
  if (!newTop) return;

  // The paused layer below stored its own state when it was pushed
  const { setHyperlitEditMode } = await import('./core.js');
  setHyperlitEditMode(newTop.savedEditMode);

  const { restoreModuleState } = await import('./index.js');
  restoreModuleState(newTop.savedModuleState);

  const { restoreSubBookState } = await import('./subBookLoader.js');
  restoreSubBookState(newTop.savedSubBookState);

  // Delay re-enabling pointer events by one frame to flush queued click events.
  // Without this, rapid overlay clicks pass through to the restored container content
  // (because the stacked overlay is gone), triggering handleMarkClick → pushStackedLayer.
  requestAnimationFrame(() => {
    if (newTop.container) newTop.container.style.pointerEvents = '';
  });

  // Re-attach note listeners if edit mode was on
  const { getHyperlitEditMode } = await import('./core.js');
  if (getHyperlitEditMode()) {
    const { attachNoteListeners, initializePlaceholders } = await import('./noteListener.js');
    attachNoteListeners();
    initializePlaceholders();
  }

  console.log(`📚 Layer ${newTop.depth} restored`);
}

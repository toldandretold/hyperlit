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
  overlay.style.zIndex = 1000 + (depth * 2);
  // Lighter opacity for layer 1 so background doesn't get too dark
  overlay.style.backgroundColor = depth === 1
    ? 'rgba(0, 0, 0, 0.15)'
    : 'rgba(0, 0, 0, 0.08)';

  // --- Container ---
  const container = document.createElement('div');
  container.className = 'hyperlit-container-stacked';
  container.setAttribute('data-layer', depth);
  container.style.zIndex = 1001 + (depth * 2);

  // Width shrinks by 2% per layer relative to the base 60%
  const widthPercent = 60 * Math.pow(0.98, depth);
  container.style.width = `${widthPercent}%`;

  // Copy max-width from base container
  container.style.maxWidth = '30ch';

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

/**
 * Close and clean up only the topmost stacked layer.
 * Restores the layer beneath it.
 */
export async function popTopLayer() {
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
    // Animate out first
    top.container.classList.remove('open');
    // Wait for animation
    await new Promise(r => setTimeout(r, 320));
    removeStackedContainerDOM(top.container, top.overlay);
  }

  // 3. Pop from stack
  popLayer();

  // 4. If stack is now empty, do full close
  if (isEmpty()) {
    // Restore edit mode from popped layer
    const { setHyperlitEditMode } = await import('./core.js');
    setHyperlitEditMode(top.savedEditMode);

    // Restore module state before full close
    const { restoreModuleState } = await import('./index.js');
    restoreModuleState(top.savedModuleState);

    const { restoreSubBookState } = await import('./subBookLoader.js');
    restoreSubBookState(top.savedSubBookState);

    // Full close sequence
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

  // Re-enable pointer events on restored layer
  newTop.container.style.pointerEvents = '';

  // Re-attach note listeners if edit mode was on
  const { getHyperlitEditMode } = await import('./core.js');
  if (getHyperlitEditMode()) {
    const { attachNoteListeners, initializePlaceholders } = await import('./noteListener.js');
    attachNoteListeners();
    initializePlaceholders();
  }

  console.log(`📚 Layer ${newTop.depth} restored`);
}

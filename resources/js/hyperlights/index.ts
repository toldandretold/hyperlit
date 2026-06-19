/**
 * Hyperlights module - Main entry point
 * Exports all hyperlight functionality in an organized manner
 */

import { book } from '../app';
import { createLazyLoader, loadNextChunkFixed, loadPreviousChunkFixed } from "../lazyLoader/index";

// Import for internal use
import { attachMarkListeners as _attachMarkListeners } from './listeners';
// Injected into createLazyLoader so the render engine stays a leaf (one-way edge: hyperlights → hypercites).
import { attachUnderlineClickListeners } from '../hypercites/index';

// Re-export all modules for backward compatibility
export { calculateCleanTextOffset, getRelativeOffsetTop, isNumericalId, findContainerWithNumericalId } from './calculations';
export { modifyNewMarks, unwrapMark, formatRelativeTime } from './marks';
export { attachMarkListeners, handleMarkClick, handleMarkHover, handleMarkHoverOut, addTouchAndClickListener } from './listeners';
export { handleSelection, initializeHighlightingControls, cleanupHighlightingControls } from './selectionToolbar';
export { createHighlightHandler, openBrainFromSelection } from './createHighlight';
export { deleteHighlightHandler } from './deleteHighlight';
export { addToHighlightsTable, removeHighlightFromNodeChunks, removeHighlightFromNodeChunksWithDeletion, removeHighlightFromHyperlights } from './database';
export { deleteHighlightById, hideHighlightById, reprocessHighlightsForNodes } from './deletion';
export { generateHighlightID, openHighlightById, attachPlaceholderBehavior } from './utils';
export { handleHighlightContainerPaste, addHighlightContainerPasteListener } from './annotationPaste';
export { getAnnotationHTML, saveAnnotationToIndexedDB, attachAnnotationListener, saveHighlightAnnotation } from './annotations';

// Legacy container functions - redirected to unified system.
// LIVE re-export (not `const x = importedFn`): a bare `export { … from }` does not READ
// the imported binding at module-init, so it can't throw a TDZ "Cannot access X before
// initialization" when this module initialises mid circular-import (containerActions is in a
// cycle with the reader graph). The eager-alias form was the prod-break culprit.
export {
  initializeHyperlitManager as initializeHighlightManager,
  openHyperlitContainer as openHighlightContainer,
  closeHyperlitContainer as closeHighlightContainer,
} from '../hyperlitContainer/containerActions';

// Lazy loader state
let highlightId: any;
let highlightLazyLoader: any;
void highlightId;

/**
 * Initialize or update the highlight lazy loader
 */
export function initOrUpdateHighlightLazyLoader(chunks: any[]): any {
  if (highlightLazyLoader) {
    // Update the nodes if the lazy loader already exists.
    highlightLazyLoader.nodes = chunks;
  } else {
    // Create the lazy loader with the given chunks.
    highlightLazyLoader = createLazyLoader({
      container: document.getElementById("highlight-container"),
      nodes: chunks,
      loadNextChunk: loadNextChunkFixed,
      loadPreviousChunk: loadPreviousChunkFixed,
      attachMarkListeners: _attachMarkListeners,
      attachUnderlineClickListeners,
      bookId: book,
    });
  }
  return highlightLazyLoader;
}

// Export lazy loader getter for compatibility
export function getHighlightLazyLoader(): any {
  return highlightLazyLoader;
}

/**
 * Hyperlights module - Main entry point
 * Exports all hyperlight functionality in an organized manner
 */

import { book } from '../app.js';
import { createLazyLoader, loadNextChunkFixed, loadPreviousChunkFixed } from "../lazyLoaderFactory.js";
import { initializeHyperlitManager, openHyperlitContainer, closeHyperlitContainer } from '../hyperlitContainer/index.js';

// Import for internal use
import { attachMarkListeners as _attachMarkListeners } from './listeners.js';

// Re-export all modules for backward compatibility
export { calculateCleanTextOffset, getRelativeOffsetTop, isNumericalId, findContainerWithNumericalId } from './calculations.js';
export { modifyNewMarks, unwrapMark, formatRelativeTime } from './marks.js';
export { attachMarkListeners, handleMarkClick, handleMarkHover, handleMarkHoverOut, addTouchAndClickListener } from './listeners.js';
export { handleSelection, initializeHighlightingControls, cleanupHighlightingControls, createHighlightHandler, deleteHighlightHandler } from './selection.js';
export { addToHighlightsTable, updateNodeHighlight, removeHighlightFromNodeChunks, removeHighlightFromNodeChunksWithDeletion, removeHighlightFromHyperlights } from './database.js';
export { deleteHighlightById, hideHighlightById, reprocessHighlightsForNodes } from './deletion.js';
export { generateHighlightID, openHighlightById, attachPlaceholderBehavior } from './utils.js';
export { handleHighlightContainerPaste, addHighlightContainerPasteListener } from './annotationPaste.js';
export { getAnnotationHTML, saveAnnotationToIndexedDB, attachAnnotationListener, saveHighlightAnnotation } from './annotations.js';

// Legacy container functions - redirected to unified system
export const initializeHighlightManager = initializeHyperlitManager;
export const openHighlightContainer = openHyperlitContainer;
export const closeHighlightContainer = closeHyperlitContainer;

// Lazy loader state
let highlightId;
let highlightLazyLoader;

/**
 * Initialize or update the highlight lazy loader
 * @param {Array} chunks - Node chunks to load
 * @returns {Object} Lazy loader instance
 */
export function initOrUpdateHighlightLazyLoader(chunks) {
  if (highlightLazyLoader) {
    // Update the nodeChunks if the lazy loader already exists.
    highlightLazyLoader.nodeChunks = chunks;
  } else {
    // Create the lazy loader with the given chunks.
    highlightLazyLoader = createLazyLoader({
      container: document.getElementById("highlight-container"),
      nodeChunks: chunks,
      loadNextChunk: loadNextChunkFixed,
      loadPreviousChunk: loadPreviousChunkFixed,
      attachMarkListeners: _attachMarkListeners,
      bookId: book,
    });
  }
  return highlightLazyLoader;
}

// Export lazy loader getter for compatibility
export function getHighlightLazyLoader() {
  return highlightLazyLoader;
}

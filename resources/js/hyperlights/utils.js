/**
 * Utils module - Utility functions for hyperlights
 */

import { handleUnifiedContentClick } from '../unifiedContainer.js';

/**
 * Generate a unique highlight ID
 * @returns {string} Unique ID in format HL_{timestamp}
 */
export function generateHighlightID() {
    let hyperLightFlag = 'HL';
    let timestamp = Date.now();
    return `${hyperLightFlag}_${timestamp}`;
}

/**
 * Open highlight by ID (legacy function - redirects to unified system)
 * @param {string|Array<string>} rawIds - Highlight ID(s)
 * @param {boolean} hasUserHighlight - Whether this is a user highlight
 * @param {Array<string>} newHighlightIds - Array of newly created highlight IDs
 */
export async function openHighlightById(
  rawIds,
  hasUserHighlight = false,
  newHighlightIds = []
) {
  // Redirect to unified system
  const highlightIds = Array.isArray(rawIds) ? rawIds : [rawIds];
  const element = document.querySelector(`mark.${highlightIds[0]}`);

  if (element) {
    console.log(`🎯 Found mark element for ${highlightIds[0]}, using element-based approach`);
    await handleUnifiedContentClick(element, highlightIds, newHighlightIds);
  } else {
    console.log(`🎯 Mark element not found for ${highlightIds[0]}, using direct highlight ID approach`);
    // Element doesn't exist yet (async loading), but we still have the highlight IDs
    // Create a dummy element object that detectHighlights can work with
    const dummyElement = {
      classList: { filter: () => highlightIds },
      tagName: 'MARK',
      _isDummy: true
    };
    await handleUnifiedContentClick(dummyElement, highlightIds, newHighlightIds);
  }
}

/**
 * Helper function to handle placeholder behavior for annotation divs
 * @param {string} highlightId - The highlight ID
 */
export function attachPlaceholderBehavior(highlightId) {
  const annotationDiv = document.querySelector(
    `.annotation[data-highlight-id="${highlightId}"]`
  );
  if (!annotationDiv) return;

  // Function to check if div is effectively empty
  const isEffectivelyEmpty = (div) => {
    return !div.textContent.trim();
  };

  // Function to update placeholder visibility
  const updatePlaceholder = () => {
    if (isEffectivelyEmpty(annotationDiv)) {
      annotationDiv.classList.add('empty-annotation');
    } else {
      annotationDiv.classList.remove('empty-annotation');
    }
  };

  // Initial check
  updatePlaceholder();

  // Update on input
  annotationDiv.addEventListener('input', updatePlaceholder);

  // Update on focus/blur for better UX
  annotationDiv.addEventListener('focus', updatePlaceholder);
  annotationDiv.addEventListener('blur', updatePlaceholder);
}

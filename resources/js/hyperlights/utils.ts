/**
 * Utils module - Utility functions for hyperlights
 */

import { handleUnifiedContentClick } from '../hyperlitContainer/containerActions';

/**
 * Generate a unique highlight ID
 * @returns Unique ID in format HL_{timestamp}
 */
export function generateHighlightID(): string {
    let hyperLightFlag = 'HL';
    let timestamp = Date.now();
    return `${hyperLightFlag}_${timestamp}`;
}

/**
 * Open highlight by ID (legacy function - redirects to unified system)
 */
export async function openHighlightById(
  rawIds: string | string[],
  hasUserHighlight = false,
  newHighlightIds: string[] = []
): Promise<void> {
  // Redirect to unified system
  const highlightIds = Array.isArray(rawIds) ? rawIds : [rawIds];
  const element = document.querySelector(`mark.${highlightIds[0]}`) as HTMLElement | null;

  if (element) {
    console.log(`🎯 Found mark element for ${highlightIds[0]}, using element-based approach`);
    await handleUnifiedContentClick(element, highlightIds, newHighlightIds);
  } else {
    console.log(`🎯 Mark element not found for ${highlightIds[0]}, using direct highlight ID approach`);
    // The mark isn't in the DOM yet (async chunk load / rapid nav). Use the direct-ID
    // path in handleUnifiedContentClick (element=null, directHyperciteId) — NOT a fake
    // element object, which lacks .closest and throws mid-navigation (freezing back/forward).
    await handleUnifiedContentClick(null, null, newHighlightIds, false, false, highlightIds[0]);
  }
}

/**
 * Helper function to handle placeholder behavior for annotation divs
 */
export function attachPlaceholderBehavior(highlightId: string): void {
  const annotationDiv = document.querySelector(
    `.annotation[data-highlight-id="${highlightId}"]`
  ) as HTMLElement | null;
  if (!annotationDiv) return;

  // Function to check if div is effectively empty
  const isEffectivelyEmpty = (div: HTMLElement) => {
    return !(div.textContent || '').trim();
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

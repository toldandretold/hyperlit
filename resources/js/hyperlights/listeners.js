/**
 * Listeners module - Handles event listeners for mark elements
 */

import { handleUnifiedContentClick } from '../hyperlitContainer/index.js';

/**
 * Attach click and hover listeners to all mark elements
 * @param {HTMLElement} scope - Scope to search within (default: document)
 */
export function attachMarkListeners(scope = document) {
    // Get all mark elements (both with ID and with just class)
    const markTags = scope.querySelectorAll("mark");
    console.log(`Attempting to attach listeners to ${markTags.length} mark elements`);

    markTags.forEach(function(mark) {
        // Remove existing listeners
        mark.removeEventListener("click", handleMarkClick);
        mark.removeEventListener("mouseover", handleMarkHover);
        mark.removeEventListener("mouseout", handleMarkHoverOut);

        // Add new listeners
        mark.addEventListener("click", handleMarkClick);
        mark.addEventListener("mouseover", handleMarkHover);
        mark.addEventListener("mouseout", handleMarkHoverOut);

        mark.dataset.listenerAttached = true;
        console.log(`Listener attached to mark with ID or class: ${mark.id || '[class only]'}`);
    });

    console.log(`Mark listeners refreshed for ${markTags.length} <mark> tags`);
}

/**
 * Handle click events on mark elements
 * @param {Event} event - Click event
 */
export async function handleMarkClick(event) {
  event.preventDefault();

  // Find the closest mark element (handles clicks on nested elements like spans)
  const markElement = event.target.closest('mark');
  if (!markElement) {
    console.log(`🎯 Click not inside a mark element - ignoring`);
    return;
  }

  // Check if the actual target is a special element that should be handled differently
  // (like links, buttons, etc. that might need their own click behavior)
  if (event.target.tagName === 'A' || event.target.tagName === 'BUTTON') {
    console.log(`🎯 Click on ${event.target.tagName} inside mark - letting it handle its own behavior`);
    return;
  }

  // Grab all classes that look like HL_* from the mark element
  const highlightIds = Array.from(markElement.classList).filter((cls) =>
    cls.startsWith("HL_")
  );
  if (highlightIds.length === 0) {
    console.error("❌ No highlight IDs found on mark");
    return;
  }

  // Check which highlights are newly created
  const newHighlightIds = markElement.getAttribute('data-new-hl');
  const newIds = newHighlightIds ? newHighlightIds.split(',') : [];

  console.log(`New highlight IDs: ${newIds.join(", ")}`);
  console.log(`Opening highlights: ${highlightIds.join(", ")}`);

  // Use unified container system - pass the mark element, not the clicked target
  await handleUnifiedContentClick(markElement, highlightIds, newIds);
}

/**
 * Handle mouseover events on mark elements
 * @param {Event} event - Mouseover event
 */
export function handleMarkHover(event) {
    const highlightId = event.target.id;
    console.log(`Mark over: ${highlightId}`);
}

/**
 * Handle mouseout events on mark elements
 * @param {Event} event - Mouseout event
 */
export function handleMarkHoverOut(event) {
    event.target.style.textDecoration = "none";
}

/**
 * Bind both click and touchstart events to an element with debouncing
 * @param {HTMLElement} element - Element to attach listeners to
 * @param {Function} handler - Event handler function
 */
export function addTouchAndClickListener(element, handler) {
  // Check if we've already attached listeners to prevent duplicates
  if (element._listenersAttached) {
    console.log("🚫 Listeners already attached to element, skipping");
    return;
  }

  // Add a flag to prevent duplicate processing within a short time window
  let isProcessing = false;

  const wrappedHandler = function(event) {
    if (isProcessing) {
      console.log("🚫 Handler already processing, ignoring duplicate event");
      return;
    }

    isProcessing = true;
    event.preventDefault();
    event.stopPropagation();

    try {
      handler(event);
    } finally {
      // Reset the flag after a short delay
      setTimeout(() => {
        isProcessing = false;
      }, 1000); // 1 second cooldown
    }
  };

  // Add the listeners
  element.addEventListener("mousedown", wrappedHandler);
  element.addEventListener("touchstart", wrappedHandler);

  // Mark that we've attached listeners using a custom property
  element._listenersAttached = true;
}

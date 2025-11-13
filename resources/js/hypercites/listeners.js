/**
 * Hypercite Event Listeners & Management
 *
 * Handles attachment and cleanup of event listeners for hypercites.
 * Manages copy button listeners and click handlers for hypercite elements.
 */

import { handleCopyEvent } from './copy.js';
import { handleUnderlineClick } from './navigation.js';
import { initializeHyperlitManager } from '../hyperlitContainer/index.js';
import { log, verbose } from '../utilities/logger.js';

// Module-level variable to track active listeners
let activeHyperciteListeners = null;

/**
 * Attach click listeners to underlined citations
 * @param {HTMLElement|Document} scope - The scope to search for elements (default: document)
 */
export function attachUnderlineClickListeners(scope = document) {
  // Select all underlined elements that don't have a listener attached yet
  const uElements = scope.querySelectorAll("u.couple:not([data-hypercite-listener]), u.poly:not([data-hypercite-listener])");

  if (uElements.length > 0) {
    uElements.forEach((uElement) => {
      uElement.style.cursor = "pointer";
      uElement.dataset.hyperciteListener = "true"; // Mark as processed

      uElement.addEventListener("click", async (event) => {
        await handleUnderlineClick(uElement, event);
      });
    });
  }

  // Only scan for annotation links when doing a full-document scan, not on a per-chunk basis.
  if (scope === document) {
    attachHyperciteLinkListeners();
  }
}

/**
 * Attach click listeners to hypercite links in contenteditable areas
 */
function attachHyperciteLinkListeners() {
  // Select all hypercite links with open-icon class within hyperlit-container
  const hyperciteLinks = document.querySelectorAll('#hyperlit-container a[id^="hypercite_"] sup.open-icon, #hyperlit-container a[id^="hypercite_"] span.open-icon');

  if (hyperciteLinks.length === 0) return;

  console.log(`Found ${hyperciteLinks.length} hypercite links in hyperlit-container to process.`);

  hyperciteLinks.forEach((linkElement) => {
    const anchorElement = linkElement.parentElement;
    if (!anchorElement || anchorElement.tagName !== 'A') return;

    // Prevent attaching duplicate listeners
    if (anchorElement.dataset.hyperciteLinkListener) {
      return;
    }
    anchorElement.dataset.hyperciteLinkListener = 'true';

    anchorElement.style.cursor = "pointer";
    linkElement.style.cursor = "pointer";

    const clickHandler = (event) => {
      event.preventDefault();
      event.stopPropagation();

      const href = anchorElement.getAttribute('href');
      if (href) {
        console.log(`Hypercite link clicked in annotation: ${href}`);
        window.open(href, '_blank');
      }
    };

    anchorElement.addEventListener('click', clickHandler);
  });
}

/**
 * Initialize hyperciting controls (copy button)
 * @param {string} currentBookId - The current book ID
 */
export function initializeHypercitingControls(currentBookId) {
  log.init(`Hyperciting controls initialized for ${currentBookId}`, '/hypercites/listeners.js');

  const copyButton = document.getElementById("copy-hypercite");
  if (!copyButton) {
    console.error(
      "Hyperciting UI controls not found. Aborting initialization."
    );
    return;
  }

  // --- START: CRITICAL FIX ---

  // 1. If there are old listeners, remove them first to prevent stacking
  if (activeHyperciteListeners) {
    copyButton.removeEventListener(
      "mousedown",
      activeHyperciteListeners.mousedown
    );
    copyButton.removeEventListener("click", activeHyperciteListeners.click);
    copyButton.removeEventListener(
      "touchend",
      activeHyperciteListeners.touchend
    );
  }

  // 2. Define the new set of listeners
  const mousedownListener = (e) => {
    // This is ESSENTIAL to prevent the button from stealing focus and
    // clearing the user's text selection.
    e.preventDefault();
  };

  const eventHandler = (event) => {
    handleCopyEvent(event, currentBookId);
  };

  // 3. Store the new listeners so we can remove them later
  activeHyperciteListeners = {
    mousedown: mousedownListener,
    click: eventHandler,
    touchend: eventHandler,
  };

  // 4. Add the new, robust listeners
  copyButton.addEventListener("mousedown", activeHyperciteListeners.mousedown);
  copyButton.addEventListener("click", activeHyperciteListeners.click, {
    passive: false,
  });
  copyButton.addEventListener("touchend", activeHyperciteListeners.touchend, {
    passive: false,
  });

  // --- END: CRITICAL FIX ---

  // Ensure button is optimized for mobile
  copyButton.style.touchAction = "manipulation";
  copyButton.style.userSelect = "none";

  // Re-initialize the ContainerManager for the pop-up
  initializeHyperciteContainerManager();
}

/**
 * Cleanup function to remove hypercite event listeners
 */
export function cleanupHypercitingControls() {
  // Clean up copy button listeners
  const copyButton = document.getElementById("copy-hypercite");
  if (copyButton && activeHyperciteListeners) {
    copyButton.removeEventListener("mousedown", activeHyperciteListeners.mousedown);
    copyButton.removeEventListener("click", activeHyperciteListeners.click);
    copyButton.removeEventListener("touchend", activeHyperciteListeners.touchend);
    activeHyperciteListeners = null;
  }

  // Clean up underline click listeners
  const hyperciteElements = document.querySelectorAll("u.couple[data-hypercite-listener], u.poly[data-hypercite-listener]");
  hyperciteElements.forEach(element => {
    element.removeAttribute("data-hypercite-listener");
    // Note: We can't remove the specific listener since it's anonymous, but removing the attribute
    // will prevent the "already attached" check from working, allowing fresh listeners
  });

  // Clean up hypercite link listeners
  const hyperciteLinks = document.querySelectorAll('#hyperlit-container a[data-hypercite-link-listener]');
  hyperciteLinks.forEach(link => {
    link.removeAttribute("data-hypercite-link-listener");
  });
}

// Legacy container functions - redirected to unified system
const initializeHyperciteContainerManager = initializeHyperlitManager;

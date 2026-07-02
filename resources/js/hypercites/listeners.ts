/**
 * Hypercite Event Listeners & Management
 *
 * Handles attachment and cleanup of event listeners for hypercites.
 * Manages copy button listeners and click handlers for hypercite elements.
 */

import { handleCopyEvent } from './copy';
import { handleUnderlineClick } from './navigation';
import { initializeHyperlitManager } from '../hyperlitContainer/containerActions';
import { verbose } from '../utilities/logger';
import { getActiveBook } from '../hyperlitContainer/utilities/activeContext';

interface HyperciteListenerSet {
  mousedown: (e: Event) => void;
  click: (e: Event) => void;
  touchend: (e: Event) => void;
}

// Module-level variable to track active listeners
let activeHyperciteListeners: HyperciteListenerSet | null = null;

// ✅ WeakMaps to track listener references for proper cleanup
const underlineListeners = new WeakMap<Element, (event: Event) => void>();
const hyperciteLinkListeners = new WeakMap<Element, (event: Event) => void>();

/**
 * Attach click listeners to underlined citations
 */
export function attachUnderlineClickListeners(scope: ParentNode = document): void {
  // Select all underlined elements that don't have a listener attached yet
  const uElements = scope.querySelectorAll("u.couple:not([data-hypercite-listener]), u.poly:not([data-hypercite-listener])");

  if (uElements.length > 0) {
    verbose.user(`Attaching underline click listeners (${uElements.length} elements)`, '/hypercites/listeners.js');

    uElements.forEach((uEl) => {
      const uElement = uEl as HTMLElement;
      // ✅ Create handler and store reference
      const clickHandler = async (event: Event) => {
        await handleUnderlineClick(uElement, event);
      };

      // Store handler reference for later removal
      underlineListeners.set(uElement, clickHandler);

      uElement.style.cursor = "pointer";
      uElement.dataset.hyperciteListener = "true"; // Mark as processed
      uElement.addEventListener("click", clickHandler);
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
function attachHyperciteLinkListeners(): void {
  // Select all hypercite anchor links within hyperlit-container
  // New format: <a class="open-icon" id="hypercite_...">, old format: <a id="hypercite_..."> with child sup/span
  const hyperciteLinks = document.querySelectorAll('#hyperlit-container a.open-icon[id^="hypercite_"], #hyperlit-container a[id^="hypercite_"] span.open-icon');

  if (hyperciteLinks.length === 0) return;

  console.log(`Found ${hyperciteLinks.length} hypercite links in hyperlit-container to process.`);

  hyperciteLinks.forEach((linkEl) => {
    const linkElement = linkEl as HTMLElement;
    // For new format, the link IS the anchor; for old format (span child), get parent
    const anchorElement = (linkElement.tagName === 'A' ? linkElement : linkElement.parentElement) as HTMLElement | null;
    if (!anchorElement || anchorElement.tagName !== 'A') return;

    // Prevent attaching duplicate listeners
    if (anchorElement.dataset.hyperciteLinkListener) {
      return;
    }
    anchorElement.dataset.hyperciteLinkListener = 'true';

    anchorElement.style.cursor = "pointer";
    linkElement.style.cursor = "pointer";

    // ✅ Create handler and store reference
    const clickHandler = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();

      const href = anchorElement.getAttribute('href');
      if (href) {
        console.log(`Hypercite link clicked in annotation: ${href}`);
        window.open(href, '_blank');
      }
    };

    // Store handler reference for later removal
    hyperciteLinkListeners.set(anchorElement, clickHandler);
    anchorElement.addEventListener('click', clickHandler);
  });
}

/**
 * Initialize hyperciting controls (copy button)
 */
export function initializeHypercitingControls(currentBookId: string): void {
  verbose.init(`Hyperciting controls initialized for ${currentBookId}`, '/hypercites/listeners.js');

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
  const mousedownListener = (e: Event) => {
    // This is ESSENTIAL to prevent the button from stealing focus and
    // clearing the user's text selection.
    e.preventDefault();
  };

  const eventHandler = (event: Event) => {
    handleCopyEvent(event, getActiveBook());
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
  initializeHyperlitManager();
}

/**
 * Cleanup function to remove hypercite copy button listeners
 */
export function cleanupHypercitingControls(): void {
  // Clean up copy button listeners
  const copyButton = document.getElementById("copy-hypercite");
  if (copyButton && activeHyperciteListeners) {
    copyButton.removeEventListener("mousedown", activeHyperciteListeners.mousedown);
    copyButton.removeEventListener("click", activeHyperciteListeners.click);
    copyButton.removeEventListener("touchend", activeHyperciteListeners.touchend);
    activeHyperciteListeners = null;
  }
}

/**
 * ✅ Cleanup function to remove underline click listeners
 * Properly removes actual event listeners using stored handler references
 */
export function cleanupUnderlineClickListeners(): void {
  verbose.user('Cleaning up underline click listeners', '/hypercites/listeners.js');

  // Clean up <u> element click listeners
  const hyperciteElements = document.querySelectorAll("u.couple[data-hypercite-listener], u.poly[data-hypercite-listener]");
  hyperciteElements.forEach(element => {
    const handler = underlineListeners.get(element);
    if (handler) {
      element.removeEventListener("click", handler);
      underlineListeners.delete(element);
    }
    element.removeAttribute("data-hypercite-listener");
  });

  // Clean up hypercite link listeners
  const hyperciteLinks = document.querySelectorAll('#hyperlit-container a[data-hypercite-link-listener]');
  hyperciteLinks.forEach(anchorElement => {
    const handler = hyperciteLinkListeners.get(anchorElement);
    if (handler) {
      anchorElement.removeEventListener("click", handler);
      hyperciteLinkListeners.delete(anchorElement);
    }
    anchorElement.removeAttribute("data-hypercite-link-listener");
  });
}

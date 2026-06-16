// The #cloudRef trigger button: attaches / detaches the click listener that
// toggles the source-container panel. The panel itself (and its singleton
// manager) lives in ../sourceContainer; this module only owns the button →
// open/close wiring, registered with ButtonRegistry as the 'sourceButton'
// component (see components/registerComponents.ts).
import sourceManager from "../sourceContainer/index";
import { log } from "../../../utilities/logger.js";

// Store handler reference for proper cleanup (like logoNav pattern)
let sourceClickHandler: any = null;

export function initializeSourceButtonListener() {
  sourceManager.rebindElements();

  if (!sourceManager.button) {
    console.warn("Source button #cloudRef not found by manager. Cannot attach listener.");
    return;
  }

  if (sourceManager.button.dataset.sourceListenerAttached) {
    return;
  }

  // Store handler reference
  sourceClickHandler = (e: any) => {
    e.preventDefault();
    sourceManager.toggleContainer();
  };

  sourceManager.button.addEventListener("click", sourceClickHandler);
  sourceManager.button.dataset.sourceListenerAttached = "true";
  log.init('Source button listener attached', '/components/topRightContainer/cloudRef/cloudRefButton.ts');
}

/**
 * Destroy source button listener
 * Properly removes event listener to prevent accumulation
 */
export function destroySourceButtonListener() {
  if (sourceManager) {
    // Close container if open and reset animation state
    sourceManager.stopAiReviewPolling();
    if (sourceManager.isOpen && sourceManager.container) {
      sourceManager.container.classList.add("hidden");
      sourceManager.container.classList.remove("open");
      sourceManager.isOpen = false;
      sourceManager.isInEditMode = false;
      (window as any).activeContainer = "main-content";
    }
    sourceManager.isAnimating = false;

    // Remove cloudRef click handler
    if (sourceManager.button && sourceClickHandler) {
      sourceManager.button.removeEventListener("click", sourceClickHandler);
      sourceClickHandler = null;
    }
    if (sourceManager.button) {
      delete sourceManager.button.dataset.sourceListenerAttached;
    }
  }
}

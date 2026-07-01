// The #cloudRef trigger button: attaches / detaches the click listener that
// toggles the source-container panel. The panel itself (and its singleton
// manager) lives in ../sourceContainer; this module only owns the button →
// open/close wiring, registered with ButtonRegistry as the 'sourceButton'
// component (see components/registerComponents.ts).
import sourceManager from "../sourceContainer/index";
import { log } from "../../utilities/logger";

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
  log.init('Source button listener attached', '/components/cloudRef/cloudRefButton.ts');
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
      sourceManager.isOpen = false;
      sourceManager.isInEditMode = false;
      (window as any).activeContainer = "main-content";
      // updateState() (isOpen=false) removes .open, clears #source-overlay.active, and
      // unfreezes frozen elements — the hand-toggling below missed the overlay, so a
      // stale full-screen #source-overlay.active survived teardown (notably on a bfcache
      // restore after navigating away via an in-container link) and blocked page scroll.
      sourceManager.updateState();
      sourceManager.container.classList.add("hidden");
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

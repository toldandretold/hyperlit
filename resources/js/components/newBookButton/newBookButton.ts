// The #newBookButton trigger: ButtonRegistry lifecycle for the new-book feature.
// Creates / rebinds the singleton NewBookContainerManager (whose base
// ContainerManager wires the #newBookButton click → toggleContainer). The panel
// + the cite-form live in ../newbookContainer; this is the thin button-side
// entry point, registered as the 'newBookButton' component in
// registerComponents.ts. Also exposes the singleton on window.newBookManager
// (read by the cite-form modules) and as the default export.
import { NewBookContainerManager } from "../newbookContainer/index";
import { log, verbose } from "../../utilities/logger";

// Container manager instance
let newBookManager: any = null;

// Initialize function that can be called after DOM changes
export function initializeNewBookContainer() {
  if (document.getElementById("newBookButton")) {
    if (!newBookManager) {
      newBookManager = new NewBookContainerManager(
        "newbook-container",
        "source-overlay",
        "newBookButton",
        ["main-content"]
      );
      log.init('New book container initialized', '/components/newBookButton/newBookButton.ts');
    } else {
      // Manager exists, just update button reference
      newBookManager.button = document.getElementById("newBookButton");
      newBookManager.rebindElements();
      log.init('New book container updated', '/components/newBookButton/newBookButton.ts');
    }

    // Make available globally for mobile link handling
    (window as any).newBookManager = newBookManager;
    return newBookManager;
  } else {
    console.log('ℹ️ NewBookContainer: Button not found, skipping initialization');
    return null;
  }
}

// Destroy function for cleanup during navigation
export function destroyNewBookContainer() {
  if (newBookManager) {
    verbose.init('Destroying new book container manager', 'newBookButton.js');
    // Clean up any open containers
    if (newBookManager.isOpen) {
      newBookManager.closeContainer();
    }
    // Call the new destroy method to remove listeners
    newBookManager.destroy();
    // Nullify the singleton instance
    newBookManager = null;
    return true;
  }
  return false;
}

// Export the manager instance for use in other files if needed
export default newBookManager;

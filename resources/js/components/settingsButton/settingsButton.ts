// The #settingsButton trigger: ButtonRegistry lifecycle for the settings feature.
// Creates / rebinds the singleton SettingsContainerManager (whose base
// ContainerManager wires the #settingsButton click → toggleContainer). The panel
// + all settings logic live in ../settingsContainer; this is the thin button-side
// entry point, registered as the 'settings' component in registerComponents.js.
import { SettingsContainerManager } from "../settingsContainer/index";
import { log, verbose } from "../../utilities/logger.js";

// Settings manager instance (singleton)
let settingsManager: any = null;

/**
 * Initialize the settings container manager
 */
export function initializeSettingsManager() {
  const settingsButton = document.getElementById("settingsButton");

  if (!settingsButton) {
    verbose.init('Settings button not found, skipping initialization', '/components/settingsButton/settingsButton.ts');
    return null;
  }

  if (!settingsManager) {
    // Create new manager instance
    settingsManager = new SettingsContainerManager(
      "settings-container",
      "settings-overlay",
      "settingsButton",
      ["main-content"]
    );
    log.init('Settings Manager initialized', '/components/settingsButton/settingsButton.ts');
  } else {
    // Manager exists, just rebind elements after SPA transition
    settingsManager.rebindElements();
    verbose.init('Settings Manager rebound', '/components/settingsButton/settingsButton.ts');
  }

  return settingsManager;
}

/**
 * Open the settings container
 */
export function openSettings() {
  if (settingsManager) {
    settingsManager.openContainer();
  }
}

/**
 * Close the settings container
 */
export function closeSettings() {
  if (settingsManager) {
    settingsManager.closeContainer();
  }
}

/**
 * Toggle the settings container
 */
export function toggleSettings() {
  if (settingsManager) {
    settingsManager.toggleContainer();
  }
}

/**
 * Destroy settings manager for cleanup during navigation
 */
export function destroySettingsManager() {
  if (settingsManager) {
    settingsManager.destroy();
    settingsManager = null;
    verbose.init('Settings Manager destroyed', '/components/settingsButton/settingsButton.ts');
    return true;
  }
  return false;
}

// settingsContainer.js - Manages the bottom-up settings panel

import { ContainerManager } from "../containerManager.js";
import { log, verbose } from "../utilities/logger.js";
import { switchTheme, getCurrentTheme, THEMES } from "../utilities/themeSwitcher.js";
import { openSearchToolbar } from "./searchToolbar.js";

/**
 * SettingsContainerManager - Extends ContainerManager with event delegation
 * Uses the same robust pattern as userContainer.js
 */
export class SettingsContainerManager extends ContainerManager {
  constructor(containerId, overlayId, buttonId, frozenContainerIds = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);

    this.boundClickHandler = this.handleDocumentClick.bind(this);
    this.boundThemeChangeHandler = this.updateButtonStates.bind(this);

    this.setupSettingsListeners();

    // Set initial button states
    this.updateButtonStates();
  }

  /**
   * Setup event delegation for theme buttons
   * Survives innerHTML replacement and SPA transitions
   */
  setupSettingsListeners() {
    document.addEventListener("click", this.boundClickHandler);
    window.addEventListener('themechange', this.boundThemeChangeHandler);
    verbose.init('Settings event listeners attached', '/components/settingsContainer.js');
  }

  /**
   * Handle all clicks inside settings container using delegation
   * Pattern from userContainer.js - queries DOM at click time
   */
  handleDocumentClick(e) {
    // Only handle clicks inside settings container or overlay
    const isInSettingsContainer = e.target.closest('#bottom-up-container');
    const isSettingsOverlay = e.target.closest('#settings-overlay');

    if (!isInSettingsContainer && !isSettingsOverlay) {
      return;
    }

    // Handle theme button clicks
    if (e.target.closest("#darkModeButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Dark mode clicked via delegation', '/components/settingsContainer.js');
      switchTheme(THEMES.DARK);
      return;
    }

    if (e.target.closest("#lightModeButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Light mode clicked via delegation', '/components/settingsContainer.js');
      switchTheme(THEMES.LIGHT);
      return;
    }

    if (e.target.closest("#sepiaModeButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Sepia mode clicked via delegation', '/components/settingsContainer.js');
      switchTheme(THEMES.SEPIA);
      return;
    }

    // Handle search button click
    if (e.target.closest("#searchButton")) {
      e.preventDefault();
      e.stopPropagation();
      verbose.init('Search button clicked via delegation', '/components/settingsContainer.js');
      this.closeContainer();
      // Open search toolbar after settings closes
      setTimeout(() => {
        openSearchToolbar();
      }, 100);
      return;
    }

    // Handle overlay click to close
    if (e.target.closest("#settings-overlay") && this.isOpen) {
      this.closeContainer();
    }
  }

  /**
   * Update button active states based on current theme
   * Called on theme change events and after rebinding
   */
  updateButtonStates() {
    const currentTheme = getCurrentTheme();

    const darkButton = document.getElementById("darkModeButton");
    const lightButton = document.getElementById("lightModeButton");
    const sepiaButton = document.getElementById("sepiaModeButton");

    // Remove all active classes
    darkButton?.classList.remove("active");
    lightButton?.classList.remove("active");
    sepiaButton?.classList.remove("active");

    // Add active class to current theme
    switch (currentTheme) {
      case THEMES.DARK:
        darkButton?.classList.add("active");
        break;
      case THEMES.LIGHT:
        lightButton?.classList.add("active");
        break;
      case THEMES.SEPIA:
        sepiaButton?.classList.add("active");
        break;
    }
  }

  /**
   * Rebind elements after SPA transitions
   * Extends parent rebindElements to also update button states
   */
  rebindElements() {
    super.rebindElements();
    this.updateButtonStates();
  }

  /**
   * Override openContainer to update button states after innerHTML replacement
   * ContainerManager.openContainer() replaces innerHTML, destroying active classes
   */
  openContainer(content = null, highlightId = null) {
    super.openContainer(content, highlightId);

    // CRITICAL: Update button states after innerHTML is replaced
    // requestAnimationFrame ensures DOM is ready
    requestAnimationFrame(() => {
      this.updateButtonStates();
      verbose.init('Button states updated after container opened', '/components/settingsContainer.js');
    });
  }

  /**
   * Proper cleanup - remove all event listeners
   */
  destroy() {
    document.removeEventListener("click", this.boundClickHandler);
    window.removeEventListener('themechange', this.boundThemeChangeHandler);
    super.destroy();
    verbose.init('Settings event listeners removed', '/components/settingsContainer.js');
  }
}

// Settings manager instance (singleton)
let settingsManager = null;

/**
 * Initialize the settings container manager
 */
export function initializeSettingsManager() {
  const settingsButton = document.getElementById("settingsButton");

  if (!settingsButton) {
    verbose.init('Settings button not found, skipping initialization', '/components/settingsContainer.js');
    return null;
  }

  if (!settingsManager) {
    // Create new manager instance
    settingsManager = new SettingsContainerManager(
      "bottom-up-container",
      "settings-overlay",
      "settingsButton",
      ["main-content"]
    );
    log.init('Settings Manager initialized', '/components/settingsContainer.js');
  } else {
    // Manager exists, just rebind elements after SPA transition
    settingsManager.rebindElements();
    verbose.init('Settings Manager rebound', '/components/settingsContainer.js');
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
    verbose.init('Settings Manager destroyed', '/components/settingsContainer.js');
    return true;
  }
  return false;
}

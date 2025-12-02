// settingsContainer.js - Manages the bottom-up settings panel

import { ContainerManager } from "../containerManager.js";
import { log } from "../utilities/logger.js";
import { switchTheme, getCurrentTheme, THEMES } from "../utilities/themeSwitcher.js";

// Get DOM elements
export const settingsContainer = document.getElementById("bottom-up-container");
export const settingsOverlay = document.getElementById("settings-overlay");
export const settingsButton = document.getElementById("settingsButton");

// Settings manager instance
let settingsManager = null;

/**
 * Update button active states based on current theme
 */
function updateButtonStates() {
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

// Track if we've added the global themechange listener
let globalThemeListenerAdded = false;

/**
 * Initialize theme button click handlers
 */
function initializeThemeButtons() {
  const darkButton = document.getElementById("darkModeButton");
  const lightButton = document.getElementById("lightModeButton");
  const sepiaButton = document.getElementById("sepiaModeButton");

  console.log('🎨 DEBUGGING: darkButton =', darkButton);
  console.log('🎨 DEBUGGING: lightButton =', lightButton);
  console.log('🎨 DEBUGGING: sepiaButton =', sepiaButton);

  if (!darkButton || !lightButton || !sepiaButton) {
    console.error('🎨 BUTTONS NOT FOUND IN DOM!', {darkButton, lightButton, sepiaButton});
    return;
  }

  console.log('🎨 Buttons found! Attaching handlers...');

  // Attach fresh listeners
  darkButton.onclick = (e) => {
    console.log('🎨 Dark mode clicked');
    e.stopPropagation();
    e.preventDefault();
    switchTheme(THEMES.DARK);
  };

  lightButton.onclick = (e) => {
    console.log('🎨 Light mode clicked');
    e.stopPropagation();
    e.preventDefault();
    switchTheme(THEMES.LIGHT);
  };

  sepiaButton.onclick = (e) => {
    console.log('🎨 Sepia mode clicked');
    e.stopPropagation();
    e.preventDefault();
    switchTheme(THEMES.SEPIA);
  };

  console.log('🎨 Handlers attached');

  // Set initial button states based on current theme
  updateButtonStates();

  // Add global theme change listener only once
  if (!globalThemeListenerAdded) {
    window.addEventListener('themechange', updateButtonStates);
    globalThemeListenerAdded = true;
  }

  console.log('🎨 ✅ Theme button initialization complete');
}

/**
 * Initialize the settings container manager
 */
export function initializeSettingsManager() {
  console.log('🎨 initializeSettingsManager called');

  if (!settingsButton) {
    console.warn('🎨 Settings button not found, aborting initialization');
    return;
  }

  if (!settingsManager) {
    settingsManager = new ContainerManager(
      "bottom-up-container",
      "settings-overlay",
      "settingsButton",
      ["main-content"],
      {
        onOpen: () => {
          // Re-initialize theme buttons after container opens and innerHTML is replaced
          console.log('🎨 onOpen callback - reinitializing theme buttons');
          initializeThemeButtons();
        }
      }
    );
    log.init('Settings Manager initialized', '/components/settingsContainer.js');
  } else {
    settingsManager.rebindElements();
  }

  // Initialize theme buttons immediately since they exist in the DOM
  initializeThemeButtons();
}

/**
 * Open the settings container
 */
export function openSettings() {
  if (settingsManager) {
    settingsManager.openContainer();

    // CRITICAL: Re-initialize theme buttons after openContainer() replaces innerHTML
    // openContainer() calls this.container.innerHTML = this.initialContent which
    // destroys the DOM elements that had click handlers attached
    initializeThemeButtons();
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
    globalThemeListenerAdded = false; // Reset flag
    return true;
  }
  return false;
}

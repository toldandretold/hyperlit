/**
 * Component Registration - Register all UI components with ButtonRegistry
 *
 * This file is the single source of truth for component lifecycle management.
 * All buttons/components that need initialization should be registered here.
 *
 * Import this file early in the application lifecycle to ensure components
 * are registered before any initialization attempts.
 */

import { buttonRegistry } from '../utilities/buttonRegistry.js';

// Import initialization and cleanup functions
import {
  initializeSettingsManager,
  destroySettingsManager
} from './settingsContainer.js';

import {
  initializeUserContainer,
  destroyUserContainer
} from './userContainer.js';

import {
  initializeTocManager,
  destroyTocManager
} from './toc.js';

import {
  initializeNewBookContainer,
  destroyNewBookContainer
} from './newBookButton.js';

import TogglePerimeterButtons from './togglePerimeterButtons.js';

import {
  initializeEditButtonListeners,
  destroyEditButtonListeners
} from './editButton.js';

import {
  initializeSourceButtonListener,
  destroySourceButtonListener
} from './sourceButton.js';

import {
  initializeLogoNav,
  destroyLogoNav
} from './logoNavToggle.js';

/**
 * Register all components
 * This function should be called once during app initialization
 */
export function registerAllComponents() {
  // ====================================================================
  // CORE NAVIGATION COMPONENTS
  // Initialize first - needed on all pages
  // ====================================================================

  buttonRegistry.register({
    name: 'logoNav',
    initFn: initializeLogoNav,
    destroyFn: destroyLogoNav,
    pages: ['reader', 'home', 'user'],
    dependencies: [],
    required: false
  });

  buttonRegistry.register({
    name: 'userContainer',
    initFn: initializeUserContainer,
    destroyFn: destroyUserContainer,
    pages: ['reader', 'home', 'user'],
    dependencies: [],
    required: false
  });

  // ====================================================================
  // PERIMETER BUTTON CONTROLS
  // Depends on nothing, controls global UI visibility
  // ====================================================================

  // Note: togglePerimeterButtons is a class instance, not a function
  // We need to handle it differently
  let perimeterButtonsInstance = null;

  buttonRegistry.register({
    name: 'perimeterButtons',
    initFn: () => {
      if (!perimeterButtonsInstance) {
        perimeterButtonsInstance = new TogglePerimeterButtons({
          elementIds: [
            "bottom-right-buttons",
            "bottom-left-buttons",
            "logoNavWrapper",
            "topRightContainer",
            "userButtonContainer",
          ],
          tapThreshold: 15,
        });
        perimeterButtonsInstance.init();
      } else {
        // Already exists, just rebind
        perimeterButtonsInstance.rebindElements();
        perimeterButtonsInstance.updatePosition();
      }
    },
    destroyFn: () => {
      if (perimeterButtonsInstance) {
        perimeterButtonsInstance.destroy();
        perimeterButtonsInstance = null;
      }
    },
    pages: ['reader', 'home', 'user'],
    dependencies: [],
    required: false
  });

  // ====================================================================
  // READER-SPECIFIC COMPONENTS
  // Only needed on reader pages
  // ====================================================================

  buttonRegistry.register({
    name: 'editButton',
    initFn: initializeEditButtonListeners,
    destroyFn: destroyEditButtonListeners,
    pages: ['reader'],
    dependencies: [],
    required: false
  });

  buttonRegistry.register({
    name: 'sourceButton',
    initFn: initializeSourceButtonListener,
    destroyFn: destroySourceButtonListener,
    pages: ['reader'],
    dependencies: [],
    required: false
  });

  buttonRegistry.register({
    name: 'toc',
    initFn: initializeTocManager,
    destroyFn: destroyTocManager,
    pages: ['reader'],
    dependencies: [],
    required: false
  });

  buttonRegistry.register({
    name: 'settings',
    initFn: initializeSettingsManager,
    destroyFn: destroySettingsManager,
    pages: ['reader', 'home', 'user'],
    dependencies: [],
    required: false
  });

  // ====================================================================
  // HOME/USER PAGE COMPONENTS
  // Only needed on home and user pages
  // ====================================================================

  buttonRegistry.register({
    name: 'newBookButton',
    initFn: initializeNewBookContainer,
    destroyFn: destroyNewBookContainer,
    pages: ['home', 'user'],
    dependencies: ['userContainer'], // Needs user auth state
    required: false
  });

  console.log('✅ All components registered with ButtonRegistry');
}

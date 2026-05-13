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
  initializeSearchToolbar,
  destroySearchToolbar,
  checkHighlightParam
} from '../search/inTextSearch/searchToolbar.js';

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

import {
  initializeHomepageDropTarget,
  destroyHomepageDropTarget
} from './homepageDropTarget.js';

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

import {
  initializeHomepageSearch,
  destroyHomepageSearch
} from '../search/postgreSQLsearch/homepageSearch.js';

import {
  initializeHomepageButtons,
  destroyHomepageDisplayUnit
} from '../homepageDisplayUnit.js';

import {
  initializeHomepageBookActions,
  destroyHomepageListeners
} from '../homepage.js';

import {
  initializeUserProfilePage,
  destroyUserProfilePage
} from './userProfilePage.js';

import {
  initializeShelfTabs,
  destroyShelfTabs
} from './shelves/shelfTabs.js';

import {
  initializeFootnoteCitationListeners,
  destroyFootnoteCitationListeners
} from '../footnotesCitations.js';

import { initFootnoteTapExtender } from '../footnoteTapExtender.js';

// ⚠️ DEPRECATED - Citation search is now integrated into edit toolbar
// See: resources/js/editToolbar/citationMode.js
// import {
//   initializeCitationSearch,
//   destroyCitationSearch
// } from '../citations/citationSearch.js';

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

  buttonRegistry.register({
    name: 'searchToolbar',
    initFn: () => {
      initializeSearchToolbar();
      // Check if navigating from homepage search with highlight param
      checkHighlightParam();
    },
    destroyFn: destroySearchToolbar,
    pages: ['reader', 'home', 'user'],
    dependencies: [],
    required: false
  });

  buttonRegistry.register({
    name: 'footnoteCitationListeners',
    initFn: initializeFootnoteCitationListeners,
    destroyFn: destroyFootnoteCitationListeners,
    pages: ['reader'],
    dependencies: [],
    required: false
  });

  let footnoteTapExtenderHandle = null;

  buttonRegistry.register({
    name: 'footnoteTapExtender',
    initFn: () => {
      footnoteTapExtenderHandle = initFootnoteTapExtender();
    },
    destroyFn: () => {
      if (footnoteTapExtenderHandle) {
        footnoteTapExtenderHandle.destroy();
        footnoteTapExtenderHandle = null;
      }
    },
    pages: ['reader'],
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

  buttonRegistry.register({
    name: 'homepageDropTarget',
    initFn: initializeHomepageDropTarget,
    destroyFn: destroyHomepageDropTarget,
    pages: ['home', 'user'],
    dependencies: ['newBookButton'], // Drop opens the import form via #importBook
    required: false
  });

  buttonRegistry.register({
    name: 'homepageSearch',
    initFn: initializeHomepageSearch,
    destroyFn: destroyHomepageSearch,
    pages: ['home'],
    dependencies: [],
    required: false
  });

  // ====================================================================
  // HOME/USER PAGE CONTENT
  // Components that manage homepage display and book actions
  // ====================================================================

  buttonRegistry.register({
    name: 'homepageDisplayUnit',
    initFn: initializeHomepageButtons,
    destroyFn: destroyHomepageDisplayUnit,
    pages: ['home', 'user'],
    dependencies: [],
    required: false
  });

  buttonRegistry.register({
    name: 'homepageBookActions',
    initFn: initializeHomepageBookActions,
    destroyFn: destroyHomepageListeners,
    pages: ['home', 'user'],
    dependencies: ['homepageDisplayUnit'],
    required: false
  });

  // ====================================================================
  // USER-ONLY COMPONENTS
  // Only needed on user profile pages
  // ====================================================================

  buttonRegistry.register({
    name: 'userProfilePage',
    initFn: initializeUserProfilePage,
    destroyFn: destroyUserProfilePage,
    pages: ['user'],
    dependencies: [],
    required: false
  });

  buttonRegistry.register({
    name: 'shelfTabs',
    initFn: initializeShelfTabs,
    destroyFn: destroyShelfTabs,
    pages: ['user'],
    dependencies: ['homepageDisplayUnit'],
    required: false
  });

  // ⚠️ DEPRECATED - Citation search is now integrated into edit toolbar
  // The citation search interface is now part of CitationMode in editToolbar/citationMode.js
  // No separate initialization needed - it's managed by the EditToolbar class
  // buttonRegistry.register({
  //   name: 'citationSearch',
  //   initFn: initializeCitationSearch,
  //   destroyFn: destroyCitationSearch,
  //   pages: ['reader'],
  //   dependencies: [],
  //   required: false
  // });

  console.log('✅ All components registered with ButtonRegistry');
}

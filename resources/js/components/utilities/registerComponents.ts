/**
 * Component Registration - Register all UI components with ButtonRegistry
 *
 * This file is the single source of truth for component lifecycle management.
 * All buttons/components that need initialization should be registered here.
 *
 * Import this file early in the application lifecycle to ensure components
 * are registered before any initialization attempts.
 */

import { buttonRegistry } from './buttonRegistry';

// Import initialization and cleanup functions
import {
  initializeSettingsManager,
  destroySettingsManager
} from '../settingsButton/settingsButton';

import {
  initializeSearchToolbar,
  destroySearchToolbar,
  checkHighlightParam
} from '../../search/inTextSearch/searchToolbar';

import {
  initializeUserContainer,
  destroyUserContainer
} from '../userButton/userButton';

import {
  initializeTocManager,
  destroyTocManager
} from '../tocToggleButton/tocToggleButton';

import {
  initializeNewBookContainer,
  destroyNewBookContainer
} from '../newBookButton/newBookButton';

import {
  initializeFileDropTarget,
  destroyFileDropTarget
} from '../fileDropTarget/fileDropTarget';

import TogglePerimeterButtons from '../togglePerimeterButtons/togglePerimeterButtons';

import {
  initializeEditButtonListeners,
  destroyEditButtonListeners
} from '../editButton/index';

import {
  initializeSourceButtonListener,
  destroySourceButtonListener
} from '../cloudRef/cloudRefButton';

import {
  initializeLogoNav,
  destroyLogoNav
} from '../logoNav/logoNav';

import {
  initializeHomepageSearch,
  destroyHomepageSearch
} from '../../search/postgreSQLsearch/homepageSearch';

import {
  initializeHomepageButtons,
  destroyHomepageDisplayUnit
} from '../homepage/homepageDisplayUnit';

import {
  initializeHomepageBookActions,
  destroyHomepageListeners
} from '../homepage/homepage';

import {
  initializeUserProfilePage,
  destroyUserProfilePage
} from '../userProfile/userProfilePage';

import {
  initializeShelfTabs,
  destroyShelfTabs
} from '../shelves/shelfTabs';

import {
  initializeFootnoteCitationListeners,
  destroyFootnoteCitationListeners
} from '../../hyperlitContainer/footnotesCitations';

import { initFootnoteTapExtender } from '../../hyperlitContainer/footnoteTapExtender';

import {
  initContainerDragger,
  destroyContainerDragger
} from '../containerDragger/containerDragger';

import {
  initSelectionAutoScroll,
  destroySelectionAutoScroll
} from '../../scrolling/selectionAutoScroll';

import { log } from "../../utilities/logger";

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
  let perimeterButtonsInstance: any = null;

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

  // Resize/drag of hyperlit-container, toc-container and stacked containers.
  // Delegated document listeners (page-agnostic), so a session singleton is enough —
  // initContainerDragger() creates once and clears stale state on re-entry. Previously
  // loaded only via reader.blade.php's @vite, so it was missing after in-SPA book opens.
  buttonRegistry.register({
    name: 'containerDragger',
    initFn: initContainerDragger,
    destroyFn: destroyContainerDragger,
    pages: ['reader', 'home', 'user'], // containers can open anywhere; the dragger is inert without a .resize-edge under the pointer
    dependencies: [],
    required: false
  });

  // Tames the native selection auto-scroll that races the reader upward during a drag-select
  // (caused by scroll-padding-top:192px inflating the browser's auto-scroll trigger band).
  // Document-level listeners → session singleton, re-init just clears stale state.
  buttonRegistry.register({
    name: 'selectionAutoScroll',
    initFn: initSelectionAutoScroll,
    destroyFn: destroySelectionAutoScroll,
    pages: ['reader'],
    dependencies: [],
    required: false
  });

  let footnoteTapExtenderHandle: any = null;

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
    pages: ['home', 'user', 'reader'],
    dependencies: ['userContainer'], // Needs user auth state
    required: false
  });

  buttonRegistry.register({
    name: 'fileDropTarget',
    initFn: initializeFileDropTarget,
    destroyFn: destroyFileDropTarget,
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

  log.init('All components registered with ButtonRegistry', '/components/utilities/registerComponents.ts');
}

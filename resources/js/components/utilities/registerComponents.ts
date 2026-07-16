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
  initAudioPlayer,
  destroyAudioPlayer
} from '../audioPlayer/index';

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
  initContentHopper,
  destroyContentHopper
} from '../contentHopper/contentHopper';

import {
  initPageNav,
  destroyPageNav
} from '../pageNav/pageNav';

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

import {
  initPaginatedSelectionBand,
  destroyPaginatedSelectionBand
} from '../../scrolling/paginatedSelectionBand';

import {
  initLavaLampBackground,
  destroyLavaLampBackground
} from '../homepage/lavaLampBackground';

import {
  initHomepageHero,
  destroyHomepageHero
} from '../homepage/homepageHero';

import {
  initWheelScrollForwarder,
  destroyWheelScrollForwarder
} from '../../scrolling/wheelScrollForwarder';

import {
  initLockedCardTitles,
  destroyLockedCardTitles
} from '../../e2ee/ui/lockedCardTitles';

import {
  initCommonsHarvestNotice,
  destroyCommonsHarvestNotice
} from '../commonsHarvestNotice/commonsHarvestNotice';

import { verbose } from "../../utilities/logger";

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

  // Keyboard hop layer for content (n/p/j/k/Enter — WCAG 2.1.1). Content is
  // never in the Tab order (chrome-only Tab model); this is the way in, on
  // EVERY page. Document-delegated singleton: create-once init.
  buttonRegistry.register({
    name: 'contentHopper',
    initFn: initContentHopper,
    destroyFn: destroyContentHopper,
    pages: ['reader', 'home', 'user'],
    dependencies: [],
    required: false
  });

  // Paginated reading mode page-turn controls (buttons + keys) + the
  // engagement re-sync on every reader entry. Document-delegated singleton:
  // create-once init, per-entry syncEngagement.
  buttonRegistry.register({
    name: 'pageNav',
    initFn: initPageNav,
    destroyFn: destroyPageNav,
    pages: ['reader'],
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
            // Reading-progress % (both scroll + paginated modes) is reading
            // chrome — tap-to-hide the perimeter buttons fades it too.
            "pageNavPercent",
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

  // "Listen to this book" — per-node TTS player (play button + bottom bar).
  // Reader-only: playback follows the open book's nodes.
  buttonRegistry.register({
    name: 'audioPlayer',
    initFn: initAudioPlayer,
    destroyFn: destroyAudioPlayer,
    pages: ['reader'],
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

  // Draws the text-selection band ourselves in paginated mode — iOS Safari doesn't
  // reliably PAINT the native selection over scrolled multicol content, though the
  // selection geometry (getClientRects) is correct. Document-level listeners →
  // session singleton, re-init just clears stale bands. Inert in scroll mode.
  buttonRegistry.register({
    name: 'paginatedSelectionBand',
    initFn: initPaginatedSelectionBand,
    destroyFn: destroyPaginatedSelectionBand,
    pages: ['reader'],
    dependencies: [],
    required: false
  });

  let footnoteTapExtenderHandle: any = null;

  // Commons-book reader notice: a one-time toast that this text was
  // auto-converted (owner-less harvested book). Inert on non-commons books.
  buttonRegistry.register({
    name: 'commonsHarvestNotice',
    initFn: initCommonsHarvestNotice,
    destroyFn: destroyCommonsHarvestNotice,
    pages: ['reader'],
    dependencies: [],
    required: false
  });

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

  // Homepage lava-lamp background + centered glass hero. Both no-op unless
  // their marker DOM exists (#lava-lamp-mount / #app-container.lava-lamp-background),
  // so they are inert everywhere but the homepage.
  buttonRegistry.register({
    name: 'lavaLampBackground',
    initFn: initLavaLampBackground,
    destroyFn: destroyLavaLampBackground,
    pages: ['home'],
    dependencies: [],
    required: false
  });

  buttonRegistry.register({
    name: 'homepageHero',
    initFn: initHomepageHero,
    destroyFn: destroyHomepageHero,
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

  // Forwards the mouse wheel to the content wrapper when the pointer sits in a
  // dead zone (over the fixed header, or the margins beside the centered column),
  // which otherwise have no scroll target on desktop. Document-delegated singleton.
  buttonRegistry.register({
    name: 'wheelScrollForwarder',
    initFn: initWheelScrollForwarder,
    destroyFn: destroyWheelScrollForwarder,
    pages: ['home', 'user', 'reader'],
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

  // E2EE (docs/e2ee.md): swaps the generic "Encrypted book" card label for the
  // real title from the LOCAL plaintext library store (owner devices only).
  // Inert when no .libraryCard-encrypted exists on the page.
  buttonRegistry.register({
    name: 'lockedCardTitles',
    initFn: initLockedCardTitles,
    destroyFn: destroyLockedCardTitles,
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

  verbose.init('All components registered with ButtonRegistry', '/components/utilities/registerComponents.ts');
}

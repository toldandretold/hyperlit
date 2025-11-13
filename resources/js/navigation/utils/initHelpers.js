/**
 * Initialization Helpers - Shared init logic for navigation transitions
 * Extracted from DifferentTemplateTransition and SameTemplateTransition for reusability
 */
import { log } from '../../utilities/logger.js';

/**
 * Initialize reader state
 * Extracted from DifferentTemplateTransition.initializeReader()
 */
export async function initializeReader(bookId, progressCallback) {
  log.nav(`Initializing reader page`, '/navigation/utils/initHelpers.js');

  try {
    // Set current book
    const { setCurrentBook } = await import('../../app.js');
    setCurrentBook(bookId);

    // Ensure data-page is set to "reader"
    document.body.setAttribute('data-page', 'reader');

    // Initialize reader functionality
    const { universalPageInitializer } = await import('../../viewManager.js');
    await universalPageInitializer(progressCallback);

    // Ensure content is loaded
    await ensureContentLoaded(bookId);

    // 🔧 Reinitialize logo navigation toggle
    const { initializeLogoNav } = await import('../../components/logoNavToggle.js');
    if (typeof initializeLogoNav === 'function') {
      initializeLogoNav();
    }

    // 🔧 Reinitialize user container (userButton is in logoNavWrapper on all pages)
    const { initializeUserContainer } = await import('../../components/userContainer.js');
    const userManager = initializeUserContainer();
    if (userManager && userManager.initializeUser) {
      await userManager.initializeUser();
    }

  } catch (error) {
    console.error('❌ Reader initialization failed:', error);
    throw error;
  }
}

/**
 * Initialize home state
 * Extracted from DifferentTemplateTransition.initializeHome()
 */
export async function initializeHome(bookId, progressCallback) {
  log.nav('Initializing home page', '/navigation/utils/initHelpers.js');

  try {
    // Set current book
    const { setCurrentBook } = await import('../../app.js');
    setCurrentBook(bookId);

    // Ensure data-page is set to "home"
    document.body.setAttribute('data-page', 'home');

    // CRITICAL: Reinitialize container managers BEFORE universalPageInitializer
    await reinitializeContainerManagers();

    // Initialize homepage functionality
    const { universalPageInitializer } = await import('../../viewManager.js');

    try {
      // Set flag to prevent double initialization
      window.containersAlreadyInitialized = true;
      await universalPageInitializer(progressCallback);
    } finally {
      delete window.containersAlreadyInitialized;
    }

    // 🔧 Reinitialize logo navigation toggle
    const { initializeLogoNav } = await import('../../components/logoNavToggle.js');
    if (typeof initializeLogoNav === 'function') {
      initializeLogoNav();
    }

  } catch (error) {
    console.error('Home initialization failed:', error);
    throw error;
  }
}

/**
 * Initialize user state
 * Extracted from DifferentTemplateTransition.initializeUser()
 */
export async function initializeUser(bookId, progressCallback) {
  log.nav('Initializing user page', '/navigation/utils/initHelpers.js');

  try {
    // Set current book
    const { setCurrentBook } = await import('../../app.js');
    setCurrentBook(bookId);

    // Ensure data-page is set to "user"
    document.body.setAttribute('data-page', 'user');

    // Initialize user-specific features (e.g., profile editor)
    await initializeUserSpecificFeatures(bookId);

    // CRITICAL: Reinitialize container managers BEFORE universalPageInitializer
    await reinitializeContainerManagers();

    // Initialize user page functionality (uses same pattern as home)
    const { universalPageInitializer } = await import('../../viewManager.js');

    try {
      window.containersAlreadyInitialized = true;
      await universalPageInitializer(progressCallback);
    } finally {
      delete window.containersAlreadyInitialized;
    }

    // 🔧 Reinitialize logo navigation toggle
    const { initializeLogoNav } = await import('../../components/logoNavToggle.js');
    if (typeof initializeLogoNav === 'function') {
      initializeLogoNav();
    }

  } catch (error) {
    console.error('User initialization failed:', error);
    throw error;
  }
}

/**
 * Initialize user-specific features (profile editor, etc.)
 * Extracted from DifferentTemplateTransition.initializeUserSpecificFeatures()
 */
export async function initializeUserSpecificFeatures(bookId) {

  try {
    // Initialize user profile editor if it exists
    const userLibraryContainer = document.getElementById('userLibraryContainer');
    if (userLibraryContainer) {
      const { initializeUserProfileEditor } = await import('../../components/userProfileEditor.js');
      if (typeof initializeUserProfileEditor === 'function') {
        await initializeUserProfileEditor(bookId);
      }
    }
  } catch (error) {
    console.warn('User-specific feature initialization failed:', error);
  }
}

/**
 * Reinitialize container managers
 * Extracted from DifferentTemplateTransition.reinitializeContainerManagers()
 */
export async function reinitializeContainerManagers() {

  try {
    // Initialize homepage-specific managers
    const { initializeUserContainer } = await import('../../components/userContainer.js');
    const userManager = initializeUserContainer();

    if (userManager && userManager.initializeUser) {
      await userManager.initializeUser();
    }

    const { initializeNewBookContainer } = await import('../../components/newBookButton.js');
    initializeNewBookContainer();

    const { initializeHomepageButtons } = await import('../../homepageDisplayUnit.js');
    initializeHomepageButtons();

  } catch (error) {
    console.warn('❌ Could not reinitialize container managers:', error);
  }
}

/**
 * Ensure content is loaded for reader pages
 * Extracted from DifferentTemplateTransition.ensureContentLoaded()
 */
export async function ensureContentLoaded(bookId) {

  try {
    if (!window.nodeChunks || window.nodeChunks.length === 0) {
      console.warn('No nodeChunks available');
      return;
    }

    const { currentLazyLoader } = await import('../../initializePage.js');
    if (!currentLazyLoader) {
      console.warn('No currentLazyLoader available');
      return;
    }

    // Check if content is already loaded
    const bookContainer = document.getElementById(bookId);
    if (bookContainer && bookContainer.children.length > 2) {
      return;
    }

    // Load the first chunk
    const firstChunk = window.nodeChunks.find(chunk => chunk.chunk_id === 0) || window.nodeChunks[0];
    if (firstChunk) {
      currentLazyLoader.loadChunk(firstChunk.chunk_id, "down");
    }

  } catch (error) {
    console.warn('Could not ensure content loaded:', error);
  }
}

/**
 * Structure-aware initialization dispatcher
 * Routes to the appropriate init function based on page structure
 */
export async function initializeToStructure(toStructure, bookId, progressCallback) {

  try {
    switch (toStructure) {
      case 'reader':
        await initializeReader(bookId, progressCallback);
        break;

      case 'home':
        await initializeHome(bookId, progressCallback);
        break;

      case 'user':
        await initializeUser(bookId, progressCallback);
        break;

      default:
        console.warn(`Unknown toStructure: ${toStructure}, using reader init`);
        await initializeReader(bookId, progressCallback);
    }
  } catch (error) {
    console.error(`Initialization for ${toStructure} failed:`, error);
    throw error;
  }
}

/**
 * Initialization Helpers - Shared init logic for navigation transitions
 * Extracted from DifferentTemplateTransition and SameTemplateTransition for reusability
 */

/**
 * Initialize reader state
 * Extracted from DifferentTemplateTransition.initializeReader()
 */
export async function initializeReader(bookId, progressCallback) {
  console.log(`📖 initHelpers: Initializing reader for ${bookId}`);

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
    console.log('🔧 initHelpers: Reinitializing logo navigation toggle');
    const { initializeLogoNav } = await import('../../components/logoNavToggle.js');
    if (typeof initializeLogoNav === 'function') {
      initializeLogoNav();
      console.log('✅ initHelpers: Logo navigation toggle initialized');
    }

    // 🔧 Reinitialize user container (userButton is in logoNavWrapper on all pages)
    console.log('🔧 initHelpers: Reinitializing user container');
    const { initializeUserContainer } = await import('../../components/userContainer.js');
    const userManager = initializeUserContainer();
    if (userManager && userManager.initializeUser) {
      await userManager.initializeUser();
    }
    console.log('✅ initHelpers: User container initialized');

    console.log('✅ initHelpers: Reader initialization complete');

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
  console.log(`🏠 initHelpers: Initializing home for ${bookId}`);

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
    console.log('🔧 initHelpers: Reinitializing logo navigation toggle');
    const { initializeLogoNav } = await import('../../components/logoNavToggle.js');
    if (typeof initializeLogoNav === 'function') {
      initializeLogoNav();
      console.log('✅ initHelpers: Logo navigation toggle initialized');
    }

    console.log('✅ initHelpers: Home initialization complete');

  } catch (error) {
    console.error('❌ Home initialization failed:', error);
    throw error;
  }
}

/**
 * Initialize user state
 * Extracted from DifferentTemplateTransition.initializeUser()
 */
export async function initializeUser(bookId, progressCallback) {
  console.log(`👤 initHelpers: Initializing user page for ${bookId}`);

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
    console.log('🔧 initHelpers: Reinitializing logo navigation toggle');
    const { initializeLogoNav } = await import('../../components/logoNavToggle.js');
    if (typeof initializeLogoNav === 'function') {
      initializeLogoNav();
      console.log('✅ initHelpers: Logo navigation toggle initialized');
    }

    console.log('✅ initHelpers: User initialization complete');

  } catch (error) {
    console.error('❌ User initialization failed:', error);
    throw error;
  }
}

/**
 * Initialize user-specific features (profile editor, etc.)
 * Extracted from DifferentTemplateTransition.initializeUserSpecificFeatures()
 */
export async function initializeUserSpecificFeatures(bookId) {
  console.log(`👤 initHelpers: Initializing user-specific features for ${bookId}`);

  try {
    // Initialize user profile editor if it exists
    const userLibraryContainer = document.getElementById('userLibraryContainer');
    if (userLibraryContainer) {
      const { initializeUserProfileEditor } = await import('../../components/userProfileEditor.js');
      if (typeof initializeUserProfileEditor === 'function') {
        await initializeUserProfileEditor(bookId);
        console.log('✅ User profile editor initialized');
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
  console.log('🔧 initHelpers: Reinitializing container managers');

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

    console.log('✅ initHelpers: Container managers reinitialized');

  } catch (error) {
    console.warn('❌ Could not reinitialize container managers:', error);
  }
}

/**
 * Ensure content is loaded for reader pages
 * Extracted from DifferentTemplateTransition.ensureContentLoaded()
 */
export async function ensureContentLoaded(bookId) {
  console.log(`📄 initHelpers: Ensuring content loaded for ${bookId}`);

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
      console.log('📄 Content already loaded');
      return;
    }

    // Load the first chunk
    const firstChunk = window.nodeChunks.find(chunk => chunk.chunk_id === 0) || window.nodeChunks[0];
    if (firstChunk) {
      console.log(`📄 Loading initial chunk ${firstChunk.chunk_id}`);
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
  console.log(`🚀 initHelpers: Initializing ${toStructure} state for ${bookId}`);

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

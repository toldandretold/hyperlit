/**
 * DifferentTemplateTransition - Universal handler for cross-structure transitions
 * Handles full body replacement for reader↔home, reader↔user, home↔user
 * Structure-aware cleanup and initialization preserving battle-tested logic
 */
import { ProgressManager } from '../ProgressManager.js';
import { LinkNavigationHandler } from '../LinkNavigationHandler.js';

export class DifferentTemplateTransition {
  /**
   * Execute cross-structure transition (full body replacement)
   */
  static async execute(options = {}) {
    const {
      fromStructure: providedFromStructure,
      toStructure: providedToStructure,
      targetUrl,
      toBook,
      hash = '',
      progressCallback
    } = options;

    // Detect structures if not provided
    const fromStructure = providedFromStructure || LinkNavigationHandler.getPageStructure();
    const toStructure = providedToStructure || await this.detectTargetStructure(targetUrl || toBook);

    console.log(`🔄 DifferentTemplateTransition: ${fromStructure}→${toStructure} transition`, options);

    try {
      const progress = progressCallback || ProgressManager.createProgressCallback('spa');

      progress(10, 'Preparing transition...');

      // Step 1: Structure-aware cleanup
      await this.cleanupFromStructure(fromStructure);

      progress(30, 'Fetching new page...');

      // Step 2: Fetch target HTML
      const targetUrlResolved = targetUrl || `/${toBook}`;
      const html = await this.fetchHtml(targetUrlResolved);

      progress(60, 'Updating page template...');

      // Step 3: Replace body content
      await this.replaceBodyContent(html);

      progress(70, 'Waiting for DOM stabilization...');

      // Wait for DOM to stabilize
      const { waitForLayoutStabilization } = await import('../../domReadiness.js');
      await waitForLayoutStabilization();

      progress(80, 'Initializing new page...');

      // Step 4: Structure-aware initialization
      const bookId = toBook || LinkNavigationHandler.getBookIdFromUrl(targetUrlResolved);
      await this.initializeToStructure(toStructure, bookId, progress);

      // Step 5: Update URL
      const newUrl = hash ? `${targetUrlResolved}${hash}` : targetUrlResolved;
      this.updateUrl(newUrl);

      // Step 6: Handle hash navigation if present
      if (hash) {
        progress(90, 'Navigating to target...');
        await this.navigateToHash(hash, toStructure);
      }

      progress(100, 'Complete!');
      await ProgressManager.hide();

      console.log(`✅ DifferentTemplateTransition: ${fromStructure}→${toStructure} transition complete`);

    } catch (error) {
      console.error(`❌ DifferentTemplateTransition: ${fromStructure}→${toStructure} transition failed:`, error);
      await ProgressManager.hide();

      // Fallback to full page navigation
      const fallbackUrl = targetUrl || `/${toBook}${hash}`;
      console.log('🔄 DifferentTemplateTransition: Falling back to full page navigation:', fallbackUrl);
      window.location.href = fallbackUrl;

      throw error;
    }
  }

  /**
   * Detect target structure from URL
   */
  static async detectTargetStructure(url) {
    // For now, use simple heuristics
    // Could be enhanced with fetch + DOM parsing if needed
    const urlObj = new URL(url, window.location.origin);
    const path = urlObj.pathname;

    // Root paths are home
    if (path === '/') {
      return 'home';
    }

    // Check if it's a user page by path
    // This is a simplified check - could enhance with user existence check
    const pathSegments = path.split('/').filter(Boolean);
    if (pathSegments.length === 1) {
      // Could be user page or reader page
      // For now, assume reader unless we can determine it's a user
      // This would need enhancement with actual user detection
      return 'reader';
    }

    return 'reader';
  }

  /**
   * Structure-aware cleanup - calls existing cleanup functions
   */
  static async cleanupFromStructure(fromStructure) {
    console.log(`🧹 DifferentTemplateTransition: Cleaning up ${fromStructure} state`);

    try {
      // 🧹 Cleanup logo navigation toggle (present on all page types)
      console.log('🧹 DifferentTemplateTransition: Cleaning up logo navigation toggle');
      const { destroyLogoNav } = await import('../../logoNavToggle.js');
      if (typeof destroyLogoNav === 'function') {
        destroyLogoNav();
        console.log('✅ DifferentTemplateTransition: Logo navigation toggle destroyed');
      }

      switch (fromStructure) {
        case 'reader':
          await this.cleanupReader();
          break;

        case 'home':
          await this.cleanupHome();
          break;

        case 'user':
          await this.cleanupUser();
          break;

        default:
          console.warn(`Unknown fromStructure: ${fromStructure}, skipping cleanup`);
      }
    } catch (error) {
      console.warn(`Cleanup from ${fromStructure} failed:`, error);
    }
  }

  /**
   * Cleanup reader state (extracted from BookToHomeTransition)
   */
  static async cleanupReader() {
    console.log('🧹 DifferentTemplateTransition: Cleaning up reader state');

    try {
      // Use existing cleanup from viewManager
      const { cleanupReaderView } = await import('../../viewManager.js');
      cleanupReaderView();

      // Reset edit mode state
      const { resetEditModeState } = await import('../../editButton.js');
      resetEditModeState();

      // Destroy user container (reader pages also have userButton)
      const { destroyUserContainer } = await import('../../userContainer.js');
      if (typeof destroyUserContainer === 'function') {
        destroyUserContainer();
      }

      // Close any open containers
      await this.closeOpenContainers();

    } catch (error) {
      console.warn('Reader cleanup failed:', error);
    }
  }

  /**
   * Cleanup home state (extracted from HomeToBookTransition)
   */
  static async cleanupHome() {
    console.log('🧹 DifferentTemplateTransition: Cleaning up home state');

    try {
      // Destroy homepage-specific managers
      const { destroyUserContainer } = await import('../../userContainer.js');
      if (typeof destroyUserContainer === 'function') {
        destroyUserContainer();
      }

      const { destroyNewBookContainer } = await import('../../newBookButton.js');
      if (typeof destroyNewBookContainer === 'function') {
        destroyNewBookContainer();
      }

      const { destroyHomepageDisplayUnit } = await import('../../homepageDisplayUnit.js');
      if (typeof destroyHomepageDisplayUnit === 'function') {
        destroyHomepageDisplayUnit();
      }

      // Close any open containers
      await this.closeOpenContainers();

    } catch (error) {
      console.warn('Home cleanup failed:', error);
    }
  }

  /**
   * Cleanup user state (similar to home + user-specific cleanup)
   */
  static async cleanupUser() {
    console.log('🧹 DifferentTemplateTransition: Cleaning up user state');

    try {
      // 🧹 CRITICAL: Destroy user profile editor first
      const { destroyUserProfileEditor } = await import('../../userProfileEditor.js');
      if (typeof destroyUserProfileEditor === 'function') {
        destroyUserProfileEditor();
        console.log('✅ DifferentTemplateTransition: User profile editor destroyed');
      }

      // User pages have same managers as home pages
      await this.cleanupHome();

    } catch (error) {
      console.warn('User cleanup failed:', error);
    }
  }

  /**
   * Close any open containers
   */
  static async closeOpenContainers() {
    try {
      const { closeHyperlitContainer } = await import('../../unifiedContainer.js');
      closeHyperlitContainer();

      // Close source container if open
      const sourceButton = document.getElementById('cloudRef');
      if (sourceButton) {
        const { default: sourceManager } = await import('../../sourceButton.js');
        if (sourceManager && sourceManager.isOpen) {
          sourceManager.closeContainer();
        }
      }
    } catch (error) {
      console.warn('Container closing failed:', error);
    }
  }

  /**
   * Fetch HTML for target URL
   */
  static async fetchHtml(url) {
    console.log(`📥 DifferentTemplateTransition: Fetching HTML from ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch HTML: ${response.status}`);
    }

    const htmlString = await response.text();
    console.log(`✅ DifferentTemplateTransition: Fetched HTML (${htmlString.length} characters)`);

    return htmlString;
  }

  /**
   * Replace body content with new HTML (full body replacement)
   */
  static async replaceBodyContent(htmlString) {
    console.log('🔄 DifferentTemplateTransition: Replacing body content (full template switch)');

    const parser = new DOMParser();
    const newDoc = parser.parseFromString(htmlString, 'text/html');

    // Remove any overlay from the fetched HTML to prevent conflicts
    const overlayInFetchedHTML = newDoc.getElementById('initial-navigation-overlay');
    if (overlayInFetchedHTML) {
      overlayInFetchedHTML.remove();
    }

    // Preserve the existing overlay before replacing body content
    const existingOverlay = document.getElementById('initial-navigation-overlay');
    const overlayToPreserve = existingOverlay ? existingOverlay.cloneNode(true) : null;

    // Replace the entire body content (template switch)
    document.body.innerHTML = newDoc.body.innerHTML;

    // Restore the overlay if it existed
    if (overlayToPreserve) {
      document.body.insertBefore(overlayToPreserve, document.body.firstChild);

      // Reset overlay to its default state
      overlayToPreserve.style.display = '';
      overlayToPreserve.style.visibility = '';

      console.log('🎯 DifferentTemplateTransition: Preserved navigation overlay');
    }

    // Sync all body attributes
    for (const { name, value } of newDoc.body.attributes) {
      document.body.setAttribute(name, value);
    }

    // Update document title
    document.title = newDoc.title;

    console.log('✅ DifferentTemplateTransition: Body content replaced successfully');
  }

  /**
   * Structure-aware initialization - calls existing init functions
   */
  static async initializeToStructure(toStructure, bookId, progressCallback) {
    console.log(`🚀 DifferentTemplateTransition: Initializing ${toStructure} state for ${bookId}`);

    try {
      switch (toStructure) {
        case 'reader':
          await this.initializeReader(bookId, progressCallback);
          break;

        case 'home':
          await this.initializeHome(bookId, progressCallback);
          break;

        case 'user':
          await this.initializeUser(bookId, progressCallback);
          break;

        default:
          console.warn(`Unknown toStructure: ${toStructure}, using reader init`);
          await this.initializeReader(bookId, progressCallback);
      }
    } catch (error) {
      console.error(`Initialization for ${toStructure} failed:`, error);
      throw error;
    }
  }

  /**
   * Initialize reader (extracted from HomeToBookTransition)
   */
  static async initializeReader(bookId, progressCallback) {
    console.log(`📖 DifferentTemplateTransition: Initializing reader for ${bookId}`);

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
      await this.ensureContentLoaded(bookId);

      // 🔧 Reinitialize logo navigation toggle
      console.log('🔧 DifferentTemplateTransition: Reinitializing logo navigation toggle');
      const { initializeLogoNav } = await import('../../logoNavToggle.js');
      if (typeof initializeLogoNav === 'function') {
        initializeLogoNav();
        console.log('✅ DifferentTemplateTransition: Logo navigation toggle initialized');
      }

      // 🔧 Reinitialize user container (userButton is in logoNavWrapper on all pages)
      console.log('🔧 DifferentTemplateTransition: Reinitializing user container');
      const { initializeUserContainer } = await import('../../userContainer.js');
      const userManager = initializeUserContainer();
      if (userManager && userManager.initializeUser) {
        await userManager.initializeUser();
      }
      console.log('✅ DifferentTemplateTransition: User container initialized');

      console.log('✅ DifferentTemplateTransition: Reader initialization complete');

    } catch (error) {
      console.error('❌ Reader initialization failed:', error);
      throw error;
    }
  }

  /**
   * Initialize home (extracted from BookToHomeTransition)
   */
  static async initializeHome(bookId, progressCallback) {
    console.log(`🏠 DifferentTemplateTransition: Initializing home for ${bookId}`);

    try {
      // Set current book
      const { setCurrentBook } = await import('../../app.js');
      setCurrentBook(bookId);

      // Ensure data-page is set to "home"
      document.body.setAttribute('data-page', 'home');

      // CRITICAL: Reinitialize container managers BEFORE universalPageInitializer
      await this.reinitializeContainerManagers();

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
      console.log('🔧 DifferentTemplateTransition: Reinitializing logo navigation toggle');
      const { initializeLogoNav } = await import('../../logoNavToggle.js');
      if (typeof initializeLogoNav === 'function') {
        initializeLogoNav();
        console.log('✅ DifferentTemplateTransition: Logo navigation toggle initialized');
      }

      console.log('✅ DifferentTemplateTransition: Home initialization complete');

    } catch (error) {
      console.error('❌ Home initialization failed:', error);
      throw error;
    }
  }

  /**
   * Initialize user (similar to home + user-specific init)
   */
  static async initializeUser(bookId, progressCallback) {
    console.log(`👤 DifferentTemplateTransition: Initializing user page for ${bookId}`);

    try {
      // Set current book
      const { setCurrentBook } = await import('../../app.js');
      setCurrentBook(bookId);

      // Ensure data-page is set to "user"
      document.body.setAttribute('data-page', 'user');

      // Initialize user-specific features (e.g., profile editor)
      await this.initializeUserSpecificFeatures(bookId);

      // CRITICAL: Reinitialize container managers BEFORE universalPageInitializer
      await this.reinitializeContainerManagers();

      // Initialize user page functionality (uses same pattern as home)
      const { universalPageInitializer } = await import('../../viewManager.js');

      try {
        window.containersAlreadyInitialized = true;
        await universalPageInitializer(progressCallback);
      } finally {
        delete window.containersAlreadyInitialized;
      }

      // 🔧 Reinitialize logo navigation toggle
      console.log('🔧 DifferentTemplateTransition: Reinitializing logo navigation toggle');
      const { initializeLogoNav } = await import('../../logoNavToggle.js');
      if (typeof initializeLogoNav === 'function') {
        initializeLogoNav();
        console.log('✅ DifferentTemplateTransition: Logo navigation toggle initialized');
      }

      console.log('✅ DifferentTemplateTransition: User initialization complete');

    } catch (error) {
      console.error('❌ User initialization failed:', error);
      throw error;
    }
  }

  /**
   * Initialize user-specific features (profile editor, etc.)
   */
  static async initializeUserSpecificFeatures(bookId) {
    console.log(`👤 DifferentTemplateTransition: Initializing user-specific features for ${bookId}`);

    try {
      // Initialize user profile editor if it exists
      const userLibraryContainer = document.getElementById('userLibraryContainer');
      if (userLibraryContainer) {
        const { initializeUserProfileEditor } = await import('../../userProfileEditor.js');
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
   * Reinitialize container managers (extracted from BookToHomeTransition)
   */
  static async reinitializeContainerManagers() {
    console.log('🔧 DifferentTemplateTransition: Reinitializing container managers');

    try {
      // Initialize homepage-specific managers
      const { initializeUserContainer } = await import('../../userContainer.js');
      const userManager = initializeUserContainer();

      if (userManager && userManager.initializeUser) {
        await userManager.initializeUser();
      }

      const { initializeNewBookContainer } = await import('../../newBookButton.js');
      initializeNewBookContainer();

      const { initializeHomepageButtons } = await import('../../homepageDisplayUnit.js');
      initializeHomepageButtons();

      console.log('✅ DifferentTemplateTransition: Container managers reinitialized');

    } catch (error) {
      console.warn('❌ Could not reinitialize container managers:', error);
    }
  }

  /**
   * Ensure content is loaded for reader pages
   */
  static async ensureContentLoaded(bookId) {
    console.log(`📄 DifferentTemplateTransition: Ensuring content loaded for ${bookId}`);

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
   * Update browser URL
   */
  static updateUrl(url) {
    try {
      const currentUrl = window.location.pathname + window.location.hash;
      if (currentUrl !== url) {
        window.history.pushState({}, '', url);
        console.log(`🔗 DifferentTemplateTransition: Updated URL to ${url}`);
      }
    } catch (error) {
      console.warn('Could not update URL:', error);
    }
  }

  /**
   * Navigate to hash target
   */
  static async navigateToHash(hash, structure) {
    if (!hash) return;

    console.log(`🎯 DifferentTemplateTransition: Navigating to hash ${hash}`);

    try {
      const targetId = hash.substring(1);

      if (structure === 'reader') {
        // Use reader navigation
        const { navigateToInternalId } = await import('../../scrolling.js');
        const { currentLazyLoader } = await import('../../initializePage.js');

        if (currentLazyLoader) {
          navigateToInternalId(targetId, currentLazyLoader, false);
        }
      } else {
        // For home/user, use simple scroll
        const targetElement = document.getElementById(targetId);
        if (targetElement) {
          targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }

      console.log(`✅ Navigated to ${hash}`);
    } catch (error) {
      console.warn(`Could not navigate to hash ${hash}:`, error);
      window.location.hash = hash;
    }
  }
}

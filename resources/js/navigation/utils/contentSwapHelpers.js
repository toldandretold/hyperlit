/**
 * Content Swap Helpers - Shared content swapping logic for navigation transitions
 * Extracted from DifferentTemplateTransition and SameTemplateTransition for reusability
 */

/**
 * Fetch HTML for target URL
 * Extracted from DifferentTemplateTransition.fetchHtml()
 */
export async function fetchHtml(url) {
  console.log(`📥 contentSwapHelpers: Fetching HTML from ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch HTML: ${response.status}`);
  }

  const htmlString = await response.text();
  console.log(`✅ contentSwapHelpers: Fetched HTML (${htmlString.length} characters)`);

  return htmlString;
}

/**
 * Replace body content with new HTML (full body replacement)
 * Extracted from DifferentTemplateTransition.replaceBodyContent()
 */
export async function replaceBodyContent(htmlString) {
  console.log('🔄 contentSwapHelpers: Replacing body content (full template switch)');

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

    console.log('🎯 contentSwapHelpers: Preserved navigation overlay');
  }

  // Sync all body attributes
  for (const { name, value } of newDoc.body.attributes) {
    document.body.setAttribute(name, value);
  }

  // Update document title
  document.title = newDoc.title;

  console.log('✅ contentSwapHelpers: Body content replaced successfully');
}

/**
 * Swap home/user content using homepageDisplayUnit pattern
 * Extracted from SameTemplateTransition.swapHomeContent()
 */
export async function swapHomeContent(bookId, showLoader = true) {
  try {
    if (showLoader) {
      const { showNavigationLoading } = await import('../../scrolling.js');
      showNavigationLoading(`Loading ${bookId}...`);
    }

    console.log(`🔄 contentSwapHelpers: Swapping content to ${bookId}`);

    // 🧹 CRITICAL: Destroy existing homepage managers before content swap
    console.log('🧹 contentSwapHelpers: Destroying homepage display unit listeners');
    const { destroyHomepageDisplayUnit } = await import('../../homepageDisplayUnit.js');
    if (typeof destroyHomepageDisplayUnit === 'function') {
      destroyHomepageDisplayUnit();
    }

    // 🧹 CRITICAL: Destroy existing user profile editor if it exists
    const currentStructure = document.body.getAttribute('data-page');
    if (currentStructure === 'user') {
      console.log('🧹 contentSwapHelpers: Destroying user profile editor listeners');
      const { destroyUserProfileEditor } = await import('../../components/userProfileEditor.js');
      if (typeof destroyUserProfileEditor === 'function') {
        destroyUserProfileEditor();
      }
    }

    // Remove existing content containers
    document.querySelectorAll('.main-content').forEach(content => {
      console.log(`🧹 Removing existing content container: ${content.id}`);
      content.remove();
    });

    // Create fresh container for the new content
    // Support both home and user page wrappers
    const mainContainer = document.querySelector('.home-content-wrapper') ||
                          document.querySelector('.user-content-wrapper');
    if (!mainContainer) {
      throw new Error('Content wrapper not found (tried .home-content-wrapper and .user-content-wrapper)');
    }

    const newContentDiv = document.createElement('div');
    newContentDiv.id = bookId;
    newContentDiv.className = 'main-content active-content';
    mainContainer.appendChild(newContentDiv);
    console.log(`✨ Created fresh content container: ${bookId}`);

    // Set the current book context (important for other systems)
    const { setCurrentBook } = await import('../../app.js');
    setCurrentBook(bookId);

    // Reset the current lazy loader so a fresh one gets created
    const { resetCurrentLazyLoader, loadHyperText } = await import('../../initializePage.js');
    resetCurrentLazyLoader();

    // Use the same loading pipeline as regular page transitions
    await loadHyperText(bookId);

    // 🔧 CRITICAL: Reinitialize homepage display unit after content load
    console.log('🔧 contentSwapHelpers: Reinitializing homepage display unit');
    const { initializeHomepageButtons, fixHeaderSpacing } = await import('../../homepageDisplayUnit.js');
    if (typeof initializeHomepageButtons === 'function') {
      initializeHomepageButtons();
    }
    if (typeof fixHeaderSpacing === 'function') {
      fixHeaderSpacing();
    }

    // 🔧 CRITICAL: Reinitialize user profile editor if on user page
    if (currentStructure === 'user') {
      console.log('🔧 contentSwapHelpers: Reinitializing user profile editor');
      const { initializeUserProfileEditor } = await import('../../components/userProfileEditor.js');
      if (typeof initializeUserProfileEditor === 'function') {
        await initializeUserProfileEditor(bookId);
      }
    }

    // 🔧 CRITICAL: Reinitialize TogglePerimeterButtons
    console.log('🔧 contentSwapHelpers: Reinitializing TogglePerimeterButtons');
    const { togglePerimeterButtons } = await import('../../readerDOMContentLoaded.js');
    if (togglePerimeterButtons) {
      togglePerimeterButtons.destroy();
      togglePerimeterButtons.rebindElements();
      togglePerimeterButtons.init();
      togglePerimeterButtons.updatePosition();
      console.log('✅ contentSwapHelpers: TogglePerimeterButtons reinitialized');
    }

    // 🔧 CRITICAL: Reinitialize logo navigation toggle
    console.log('🔧 contentSwapHelpers: Reinitializing logo navigation toggle');
    const { destroyLogoNav, initializeLogoNav } = await import('../../components/logoNavToggle.js');
    if (destroyLogoNav && initializeLogoNav) {
      destroyLogoNav();
      initializeLogoNav();
      console.log('✅ contentSwapHelpers: Logo navigation toggle reinitialized');
    }

    // 🔧 CRITICAL: Reinitialize user container (userButton in logoNavWrapper on user/reader pages)
    console.log('🔧 contentSwapHelpers: Reinitializing user container');
    const { initializeUserContainer } = await import('../../components/userContainer.js');
    const userManager = initializeUserContainer();
    if (userManager && userManager.initializeUser) {
      await userManager.initializeUser();
    }
    console.log('✅ contentSwapHelpers: User container reinitialized');

    console.log(`✅ Successfully loaded ${bookId} content`);

    if (showLoader) {
      const { hideNavigationLoading } = await import('../../scrolling.js');
      hideNavigationLoading();
    }

  } catch (error) {
    console.error(`❌ Failed to swap content to ${bookId}:`, error);
    if (showLoader) {
      const { hideNavigationLoading } = await import('../../scrolling.js');
      hideNavigationLoading();
    }
    throw error;
  }
}

/**
 * Navigate to hash target if provided
 * Extracted from SameTemplateTransition.navigateToHash()
 */
export async function navigateToHash(hash, structure = 'reader') {
  if (!hash) return;

  console.log(`🎯 contentSwapHelpers: Navigating to hash ${hash}`);

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

/**
 * Update browser URL
 */
export function updateUrl(url) {
  try {
    const currentUrl = window.location.pathname + window.location.hash;
    if (currentUrl !== url) {
      window.history.pushState({}, '', url);
      console.log(`🔗 contentSwapHelpers: Updated URL to ${url}`);
    }
  } catch (error) {
    console.warn('Could not update URL:', error);
  }
}

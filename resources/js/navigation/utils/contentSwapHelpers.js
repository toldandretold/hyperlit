/**
 * Content Swap Helpers - Shared content swapping logic for navigation transitions
 * Extracted from DifferentTemplateTransition and SameTemplateTransition for reusability
 */
import { log } from '../../utilities/logger.js';
import { ProgressOverlayEnactor } from '../ProgressOverlayEnactor.js';
import { showNavigationLoading, hideNavigationLoading, navigateToInternalId } from '../../scrolling.js';
import { destroyHomepageDisplayUnit, initializeHomepageButtons, fixHeaderSpacing } from '../../homepageDisplayUnit.js';
import { destroyUserProfileEditor, initializeUserProfileEditor } from '../../components/userProfileEditor.js';
import { setCurrentBook } from '../../app.js';
import { updateDatabaseBookId } from '../../indexedDB/index.js';
import { resetCurrentLazyLoader, loadHyperText, currentLazyLoader } from '../../initializePage.js';
// ✅ REMOVED: togglePerimeterButtons now managed by ButtonRegistry
// import { togglePerimeterButtons } from '../../readerDOMContentLoaded.js';
import { destroyLogoNav, initializeLogoNav } from '../../components/logoNavToggle.js';
import { initializeUserContainer } from '../../components/userContainer.js';

/**
 * Fetch HTML for target URL
 * Extracted from DifferentTemplateTransition.fetchHtml()
 */
export async function fetchHtml(url) {
  log.nav('Fetching target page', '/navigation/utils/contentSwapHelpers.js');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch HTML: ${response.status}`);
  }

  const htmlString = await response.text();
  return htmlString;
}

/**
 * Replace body content with new HTML (full body replacement)
 * Extracted from DifferentTemplateTransition.replaceBodyContent()
 */
export async function replaceBodyContent(htmlString) {
  log.nav('Replacing page template', '/navigation/utils/contentSwapHelpers.js');

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

    // DON'T reset the overlay styles - keep it in whatever state it was
    // If it was visible during navigation, keep it visible
    // The NavigationManager will hide it when ready

    // 🔥 CRITICAL: Rebind ProgressOverlayEnactor to the preserved element
    // After body replacement, ProgressOverlayEnactor's reference is stale
    // Already imported statically
    ProgressOverlayEnactor.rebind();
  }

  // Sync all body attributes
  for (const { name, value } of newDoc.body.attributes) {
    document.body.setAttribute(name, value);
  }

  // Update document title
  document.title = newDoc.title;
}

/**
 * Swap home/user content using homepageDisplayUnit pattern
 * Extracted from SameTemplateTransition.swapHomeContent()
 */
export async function swapHomeContent(bookId, showLoader = true) {
  try {
    if (showLoader) {
      // Already imported statically
      showNavigationLoading(`Loading ${bookId}...`);
    }

    // 🧹 CRITICAL: Destroy existing homepage managers before content swap
    // Already imported statically
    if (typeof destroyHomepageDisplayUnit === 'function') {
      destroyHomepageDisplayUnit();
    }

    // 🧹 CRITICAL: Destroy existing user profile editor if it exists
    const currentStructure = document.body.getAttribute('data-page');
    if (currentStructure === 'user') {
      // Already imported statically
      if (typeof destroyUserProfileEditor === 'function') {
        destroyUserProfileEditor();
      }
    }

    // Remove existing content containers
    document.querySelectorAll('.main-content').forEach(content => {
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

    // Set the current book context (important for other systems)
    // Already imported statically
    setCurrentBook(bookId);
    updateDatabaseBookId(bookId);

    // Reset the current lazy loader so a fresh one gets created
    // Already imported statically
    resetCurrentLazyLoader();

    // Use the same loading pipeline as regular page transitions
    await loadHyperText(bookId);

    // 🔧 CRITICAL: Reinitialize homepage display unit after content load
    // Already imported statically
    if (typeof initializeHomepageButtons === 'function') {
      initializeHomepageButtons();
    }
    if (typeof fixHeaderSpacing === 'function') {
      fixHeaderSpacing();
    }

    // 🔧 CRITICAL: Reinitialize user profile editor if on user page
    if (currentStructure === 'user') {
      // Already imported statically
      if (typeof initializeUserProfileEditor === 'function') {
        await initializeUserProfileEditor(bookId);
      }
    }

    // ✅ REMOVED: Manual TogglePerimeterButtons management (now handled by ButtonRegistry)
    // OLD CODE:
    // if (togglePerimeterButtons) {
    //   togglePerimeterButtons.destroy();
    //   togglePerimeterButtons.rebindElements();
    //   togglePerimeterButtons.init();
    //   togglePerimeterButtons.updatePosition();
    // }
    // NOW: ButtonRegistry handles this automatically

    // 🔧 CRITICAL: Reinitialize logo navigation toggle
    // Already imported statically
    if (destroyLogoNav && initializeLogoNav) {
      destroyLogoNav();
      initializeLogoNav();
    }

    // 🔧 CRITICAL: Reinitialize user container (userButton in logoNavWrapper on user/reader pages)
    // Already imported statically
    const userManager = initializeUserContainer();
    if (userManager && userManager.initializeUser) {
      await userManager.initializeUser();
    }

    if (showLoader) {
      // Already imported statically
      hideNavigationLoading();
    }

  } catch (error) {
    console.error(`❌ Failed to swap content to ${bookId}:`, error);
    if (showLoader) {
      // Already imported statically
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

  try {
    const targetId = hash.substring(1);

    if (structure === 'reader') {
      // Use reader navigation
      // Already imported statically
      // Already imported statically

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
  } catch (error) {
    console.warn(`Could not navigate to hash ${hash}:`, error);
    window.location.hash = hash;
  }
}

/**
 * Update browser URL with state preservation for back button support
 * Modeled after BookToBookTransition.updateUrlWithStatePreservation()
 */
export function updateUrl(url, options = {}) {
  try {
    const currentUrl = window.location.pathname + window.location.hash;
    if (currentUrl !== url) {
      // Preserve existing history state and add transition metadata
      const currentState = history.state || {};

      const newState = {
        ...currentState,
        transition: {
          fromBook: options.fromBook || null,
          toBook: options.toBook || null,
          fromStructure: options.fromStructure || null,
          toStructure: options.toStructure || null,
          transitionType: options.transitionType || 'spa',
          timestamp: Date.now()
        }
      };

      window.history.pushState(newState, '', url);
      log.nav('Updated browser URL', '/navigation/utils/contentSwapHelpers.js');
    }
  } catch (error) {
    console.warn('Could not update URL:', error);
  }
}

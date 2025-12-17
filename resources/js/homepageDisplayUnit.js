import { loadHyperText, resetCurrentLazyLoader } from './initializePage.js';
import { setCurrentBook } from './app.js';
import { showNavigationLoading, hideNavigationLoading } from './scrolling.js';
import { log, verbose } from './utilities/logger.js';

// Storage key for active button persistence
const STORAGE_KEY_ACTIVE_BUTTON = 'homepage_active_button';

let resizeHandler = null;
const buttonHandlers = new Map();

// Fix header spacing dynamically based on actual header height
export function fixHeaderSpacing() {
  // Skip for user page - CSS handles it, JS adjustment causes scroll issues
  if (document.body.dataset.page === 'user') {
    return;
  }

  const header = document.querySelector('.fixed-header');
  const wrapper = document.querySelector('.home-content-wrapper');

  if (header && wrapper) {
    const headerHeight = header.offsetHeight;
    wrapper.style.paddingTop = (headerHeight + 10) + 'px';
  }
}

// Align header content with main content text dynamically
function alignHeaderContent() {
  const mainContent = document.querySelector('body[data-page="home"] .main-content, body[data-page="user"] .main-content');
  const headerContainer = document.getElementById('imageContainer') || document.getElementById('userLibraryContainer');
  const buttonsContainer = document.querySelector('.arranger-buttons-container');

  if (mainContent && headerContainer && buttonsContainer) {
    // Calculate the left edge of the actual text content
    const mainContentRect = mainContent.getBoundingClientRect();
    const mainContentPadding = parseInt(getComputedStyle(mainContent).paddingLeft);
    const textLeftEdge = mainContentRect.left + mainContentPadding;

    // Get current position of header container (without any margin)
    headerContainer.style.marginLeft = '0px'; // Reset to get base position
    const headerRect = headerContainer.getBoundingClientRect();

    // Calculate needed offset from the header's current position
    const neededMargin = textLeftEdge - headerRect.left;

    // Apply the calculated margin to align header content with main content
    // Skip userLibraryContainer on user page - CSS padding handles alignment
    const isUserPage = document.body.dataset.page === 'user';
    const isUserLibrary = headerContainer.id === 'userLibraryContainer';

    if (!(isUserPage && isUserLibrary)) {
      headerContainer.style.marginLeft = neededMargin + 'px';
    }
    buttonsContainer.style.marginLeft = neededMargin + 'px';
  }
}

export function initializeHomepageButtons() {
  // First, ensure any old listeners are cleaned up
  destroyHomepageDisplayUnit();

  // Fix header spacing on initialization
  fixHeaderSpacing();
  
  // Align header content with text content
  alignHeaderContent();
  
  // Set up and store the resize handler
  resizeHandler = () => {
    fixHeaderSpacing();
    alignHeaderContent();
  };
  window.addEventListener('resize', resizeHandler);

  // Restore saved active button state from localStorage
  const savedActiveButton = localStorage.getItem(STORAGE_KEY_ACTIVE_BUTTON);
  if (savedActiveButton) {
    // Update DOM to reflect saved state
    document.querySelectorAll('.arranger-button').forEach(btn => {
      btn.classList.remove('active');
      if (btn.dataset.content === savedActiveButton) {
        btn.classList.add('active');
      }
    });
  }

  // Initialize the default active content on page load
  const activeButton = document.querySelector('.arranger-button.active');
  if (activeButton) {
    const initialTargetId = activeButton.dataset.content;
    transitionToBookContent(initialTargetId, false); // No loading overlay on initial load
  } else {
    // No buttons exist (e.g., non-owner viewing user page)
    // Load the public content by default using the main-content div's ID
    const mainContent = document.querySelector('.main-content');
    if (mainContent && mainContent.id) {
      console.log(`📄 No arranger buttons found, loading default content: ${mainContent.id}`);
      transitionToBookContent(mainContent.id, false);
    }
  }
  
  document.querySelectorAll('.arranger-button').forEach(button => {
    const handler = async function() {
      const targetId = this.dataset.content;

      if (this.classList.contains('active')) {
        console.log(`📄 ${targetId} is already active, skipping reinitialization`);
        return;
      }

      document.querySelectorAll('.arranger-button').forEach(btn => btn.classList.remove('active'));
      this.classList.add('active');

      // Save active button to localStorage
      localStorage.setItem(STORAGE_KEY_ACTIVE_BUTTON, targetId);

      await transitionToBookContent(targetId, true);
    };
    button.addEventListener('click', handler);
    buttonHandlers.set(button, handler); // Store handler for cleanup
  });
}

export function destroyHomepageDisplayUnit() {
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
    verbose.init('Homepage resize listener removed', 'homepageDisplayUnit.js');
  }

  buttonHandlers.forEach((handler, button) => {
    button.removeEventListener('click', handler);
  });
  buttonHandlers.clear();
  verbose.init('Homepage button listeners removed', 'homepageDisplayUnit.js');

  // Note: Homepage search cleanup is handled by ButtonRegistry
}

async function transitionToBookContent(bookId, showLoader = true) {
  try {
    if (showLoader) {
      showNavigationLoading(`Loading ${bookId}...`);
    }

    log.content(`Homepage content transition: ${bookId}`, 'homepageDisplayUnit.js');

    // Remove existing content containers
    document.querySelectorAll('.main-content').forEach(content => {
      verbose.content(`Removing existing content: ${content.id}`, 'homepageDisplayUnit.js');
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
    verbose.content(`Created fresh content container: ${bookId}`, 'homepageDisplayUnit.js');

    // Note: setCurrentBook() is handled by the navigation pathway
    // (initHelpers.js for Different-Template, or transition pathway for Same-Template)

    // Reset the current lazy loader so a fresh one gets created
    resetCurrentLazyLoader();

    // Use the same loading pipeline as regular page transitions
    await loadHyperText(bookId);

    // Realign header content after new content is loaded
    alignHeaderContent();

    verbose.content(`Successfully loaded ${bookId} content`, 'homepageDisplayUnit.js');
    
    if (showLoader) {
      hideNavigationLoading();
    }
    
  } catch (error) {
    console.error(`❌ Failed to transition to ${bookId}:`, error);
    if (showLoader) {
      hideNavigationLoading();
    }
    // Could show an error state here
  }
}


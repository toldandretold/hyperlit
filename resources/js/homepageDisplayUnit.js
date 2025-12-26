import { loadHyperText, resetCurrentLazyLoader } from './initializePage.js';
import { setCurrentBook } from './app.js';
import { showNavigationLoading, hideNavigationLoading } from './scrolling.js';
import { log, verbose } from './utilities/logger.js';
import { getAllOfflineAvailableBooks } from './indexedDB/index.js';

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

export async function initializeHomepageButtons() {
  // First, ensure any old listeners are cleaned up
  destroyHomepageDisplayUnit();

  // Check if offline - show offline mode UI instead
  if (!navigator.onLine) {
    await initializeOfflineHomepage();
    return;
  }

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

/**
 * Initialize homepage in offline mode
 * Dims the tab buttons and shows only locally-cached books
 */
async function initializeOfflineHomepage() {
  console.log('📱 Initializing homepage in offline mode');

  // Dim the tab buttons
  const buttons = document.querySelectorAll('.arranger-button');
  buttons.forEach(btn => {
    btn.classList.add('offline-disabled');
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
  });

  // Add offline mode indicator above the buttons
  const buttonsContainer = document.querySelector('.arranger-buttons-container');
  if (buttonsContainer && !document.getElementById('offline-mode-indicator')) {
    const offlineIndicator = document.createElement('div');
    offlineIndicator.id = 'offline-mode-indicator';
    offlineIndicator.innerHTML = '<em>offline mode</em>';
    offlineIndicator.style.cssText = 'color: var(--hyperlit-orange, #EF8D34); font-style: italic; margin-bottom: 10px; font-size: 0.9em;';
    buttonsContainer.insertBefore(offlineIndicator, buttonsContainer.firstChild);
  }

  // Get offline-available books
  const offlineBooks = await getAllOfflineAvailableBooks();
  console.log('📱 Offline books returned:', offlineBooks);

  // Remove existing content and create offline book list
  const mainContainer = document.querySelector('.home-content-wrapper') ||
                        document.querySelector('.user-content-wrapper');
  if (!mainContainer) {
    console.error('❌ Content wrapper not found for offline mode');
    return;
  }

  // Remove existing content containers
  document.querySelectorAll('.main-content').forEach(content => content.remove());

  // Create fresh container for offline books
  const newContentDiv = document.createElement('div');
  newContentDiv.id = 'offline-books';
  newContentDiv.className = 'main-content active-content';
  // Ensure minimum top margin to clear fixed header (backup for when CSS isn't loaded)
  newContentDiv.style.marginTop = '20px';
  mainContainer.appendChild(newContentDiv);

  // Render offline books or empty state
  if (offlineBooks.length > 0) {
    for (const libraryRecord of offlineBooks) {
      const card = createOfflineBookCard(libraryRecord);
      newContentDiv.appendChild(card);
    }
  } else {
    newContentDiv.innerHTML = '<p style="color: var(--hyperlit-white, #fff); text-align: center; padding: 2em;"><em>No books available offline</em></p>';
  }

  // Set up listener for when we come back online
  window.addEventListener('online', handleOnlineRestored, { once: true });

  // Fix header spacing AFTER content is created to ensure proper layout
  // Use requestAnimationFrame to ensure DOM has updated
  requestAnimationFrame(() => {
    const header = document.querySelector('.fixed-header');
    const wrapper = document.querySelector('.home-content-wrapper');

    if (header && wrapper) {
      const headerHeight = header.offsetHeight || 200; // Default if not rendered yet
      const currentPadding = parseInt(wrapper.style.paddingTop) || 0;

      // Only set if not already sufficient (CSS might not be loaded offline)
      if (currentPadding < headerHeight) {
        wrapper.style.paddingTop = (headerHeight + 20) + 'px';
        console.log(`📱 Set wrapper padding-top to ${headerHeight + 20}px (header height: ${headerHeight})`);
      }
    }

    fixHeaderSpacing();
    alignHeaderContent();
    console.log('📱 Header spacing applied for offline mode');
  });

  console.log(`📱 Offline homepage initialized with ${offlineBooks.length} books`);
}

/**
 * Create a book card element for offline display
 * Uses bibtex if available, falls back to title/author
 * @param {Object} libraryRecord - Library record from IndexedDB
 * @returns {HTMLElement} Book card paragraph element
 */
function createOfflineBookCard(libraryRecord) {
  const p = document.createElement('p');
  p.className = 'libraryCard';
  p.id = `offline-${libraryRecord.book}`;

  let citationHtml = '';

  // Try to use bibtex if available
  if (libraryRecord.bibtex) {
    citationHtml = parseBibtexToCitation(libraryRecord.bibtex);
  }

  // Fall back to individual fields
  if (!citationHtml) {
    const author = libraryRecord.author || '';
    const title = libraryRecord.title || 'Untitled';
    const year = libraryRecord.year || '';

    if (author) {
      citationHtml += `<strong>${escapeHtml(author)}</strong>. `;
    }
    citationHtml += `<em>${escapeHtml(title)}</em>`;
    if (year) {
      citationHtml += ` (${escapeHtml(year)})`;
    }
  }

  p.innerHTML = `
    ${citationHtml}
    <a href="/${libraryRecord.book}"><span class="open-icon">↗</span></a>
  `;

  return p;
}

/**
 * Parse bibtex string into formatted citation HTML
 * @param {string} bibtex - BibTeX entry string
 * @returns {string} Formatted citation HTML or empty string
 */
function parseBibtexToCitation(bibtex) {
  if (!bibtex || typeof bibtex !== 'string') return '';

  try {
    // Extract fields from bibtex
    const getField = (field) => {
      const regex = new RegExp(`${field}\\s*=\\s*[{"]([^}"]+)[}"]`, 'i');
      const match = bibtex.match(regex);
      return match ? match[1].trim() : '';
    };

    const author = getField('author');
    const title = getField('title');
    const year = getField('year');
    const journal = getField('journal');
    const publisher = getField('publisher');

    if (!author && !title) return '';

    let citation = '';
    if (author) {
      citation += `<strong>${escapeHtml(author)}</strong>. `;
    }
    if (title) {
      citation += `<em>${escapeHtml(title)}</em>`;
    }
    if (year) {
      citation += ` (${escapeHtml(year)})`;
    }
    if (journal) {
      citation += `. ${escapeHtml(journal)}`;
    } else if (publisher) {
      citation += `. ${escapeHtml(publisher)}`;
    }

    return citation;
  } catch (e) {
    console.warn('Failed to parse bibtex:', e);
    return '';
  }
}

/**
 * Escape HTML special characters
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Handle coming back online from offline homepage
 * Re-enables buttons and reloads normal content
 */
function handleOnlineRestored() {
  console.log('📡 Back online - restoring homepage');

  // Remove offline indicator
  const indicator = document.getElementById('offline-mode-indicator');
  if (indicator) indicator.remove();

  // Re-enable buttons
  const buttons = document.querySelectorAll('.arranger-button');
  buttons.forEach(btn => {
    btn.classList.remove('offline-disabled');
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor = '';
  });

  // Re-initialize normally
  initializeHomepageButtons();
}


/**
 * Hyperlit Container Utilities
 * Shared helper functions used across the hyperlit container system
 */

/**
 * Format a timestamp into relative time (e.g., "2min", "3hr", "5d")
 * @param {number} timeSince - Unix timestamp in seconds
 * @returns {string} Formatted relative time string
 */
export function formatRelativeTime(timeSince) {
  if (!timeSince) return 'prehistoric';

  const now = Math.floor(Date.now() / 1000);
  const diffSeconds = now - timeSince;

  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffSeconds / 3600);
  const diffDays = Math.floor(diffSeconds / 86400);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffMinutes < 1) return 'now';
  if (diffMinutes < 60) return `${diffMinutes}min`;
  if (diffHours < 24) return `${diffHours}hr`;
  if (diffDays < 7) return `${diffDays}d`;
  if (diffWeeks < 4) return `${diffWeeks}w`;
  if (diffMonths < 12) return `${diffMonths}m`;
  return `${diffYears}y`;
}

/**
 * Fetch library record from server as fallback when not in IndexedDB
 * @param {string} bookId - The book ID to fetch library data for
 * @returns {Promise<Object|null>} Library data object or null if not found
 */
export async function fetchLibraryFromServer(bookId) {
  try {
    const response = await fetch(`/api/database-to-indexeddb/books/${bookId}/library`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').getAttribute('content'),
      },
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Server request failed: ${response.status}`);
    }

    const data = await response.json();

    // The API returns {success: true, library: {...}, book_id: ...}
    if (data && data.success && data.library) {
      if (data.library.bibtex) {
        return data.library;
      } else if (data.library.title || data.library.author) {
        // Create basic bibtex from available fields
        const basicBibtex = `@misc{${bookId},
  author = {${data.library.author || 'Unknown'}},
  title = {${data.library.title || 'Untitled'}},
  year = {${new Date().getFullYear()}},
}`;
        return {
          ...data.library,
          bibtex: basicBibtex
        };
      }
    }

    return null;
  } catch (error) {
    console.error('Failed to fetch library record from server:', error);
    return null;
  }
}

/**
 * Scroll the focused/active element into view within the container
 * (Note: Currently unused - auto-scroll was removed per user request)
 * @param {HTMLElement} container - The container element
 */
export function scrollFocusedElementIntoView(container) {
  const scroller = container.querySelector('.scroller');
  if (!scroller) return;

  // Find focused element within container
  const focusedElement = container.querySelector(':focus');
  if (!focusedElement) return;

  console.log(`🎯 Scrolling focused element into view:`, focusedElement);

  // Get element position relative to scroller
  const scrollerRect = scroller.getBoundingClientRect();
  const elementRect = focusedElement.getBoundingClientRect();

  // Calculate if element is outside visible area
  const elementTop = elementRect.top - scrollerRect.top + scroller.scrollTop;
  const elementBottom = elementTop + elementRect.height;
  const visibleTop = scroller.scrollTop;
  const visibleBottom = scroller.scrollTop + scroller.clientHeight;

  // Add buffer for comfortable viewing
  const buffer = 20;

  // Scroll if element is not fully visible
  if (elementBottom + buffer > visibleBottom) {
    // Element is below visible area
    const scrollTarget = elementBottom - scroller.clientHeight + buffer;
    scroller.scrollTo({ top: scrollTarget, behavior: 'smooth' });
    console.log(`⬇️ Scrolled down to show element`);
  } else if (elementTop - buffer < visibleTop) {
    // Element is above visible area
    const scrollTarget = elementTop - buffer;
    scroller.scrollTo({ top: scrollTarget, behavior: 'smooth' });
    console.log(`⬆️ Scrolled up to show element`);
  } else {
    console.log(`✅ Element already visible, no scroll needed`);
  }
}

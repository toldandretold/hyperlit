/**
 * Marks module - Handles mark element DOM manipulation
 */

/**
 * Modify newly created marks with highlight ID and classes
 * @param {string} highlightId - The unique highlight ID
 */
export function modifyNewMarks(highlightId) {
    const newMarks = document.querySelectorAll('mark.highlight');
    newMarks.forEach((mark, index) => {
        if (index === 0) mark.setAttribute('id', highlightId);

        // Add classes separately - this is the fix!
        mark.classList.add(highlightId);
        mark.classList.add('user-highlight'); // Add user-highlight class for new highlights
        mark.classList.remove('highlight');

        // Add data-new-hl attribute to identify this as a newly created highlight
        mark.setAttribute('data-new-hl', highlightId);

        // Add data-highlight-count (default to 1 for new highlights)
        const highlightCount = 1;
        mark.setAttribute('data-highlight-count', highlightCount);

        // Add highlight intensity (same calculation as in applyHighlights)
        const intensity = Math.min(highlightCount / 5, 1);
        mark.style.setProperty('--highlight-intensity', intensity);
    });
    console.log("✅ New highlight mark created with ID:", highlightId);
}

/**
 * Unwrap a mark element, preserving its content
 * @param {HTMLElement} mark - The mark element to unwrap
 */
export function unwrapMark(mark) {
  if (!mark || !mark.parentNode) return;
  const parent = mark.parentNode;
  while (mark.firstChild) {
    parent.insertBefore(mark.firstChild, mark);
  }
  parent.removeChild(mark);

  // ✅ normalize here, since parent is available
  if (typeof parent.normalize === "function") {
    parent.normalize();
  }
}

/**
 * Format relative time from Unix timestamp
 * @param {number} timeSince - Unix timestamp in seconds
 * @returns {string} Formatted relative time (e.g., "5min", "2hr", "3d")
 */
export function formatRelativeTime(timeSince) {
  if (!timeSince) return 'prehistoric'; // Changed from '' to 'prehistoric'

  const now = Math.floor(Date.now() / 1000); // Current Unix timestamp
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

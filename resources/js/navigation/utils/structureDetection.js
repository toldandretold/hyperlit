/**
 * Structure Detection Utilities
 * Determines page structure type for navigation routing
 *
 * Extracted from LinkNavigationHandler to avoid circular dependencies
 */

/**
 * Get page structure type based on DOM elements
 * Returns 'reader', 'home', or 'user'
 */
export function getPageStructure() {
  if (document.querySelector('.reader-content-wrapper')) {
    return 'reader';
  }
  if (document.querySelector('.home-content-wrapper')) {
    return 'home';
  }
  if (document.querySelector('.user-content-wrapper')) {
    return 'user';
  }

  // Fallback to data-page attribute
  const pageType = document.body.getAttribute('data-page');
  if (pageType) {
    return pageType;
  }

  console.warn('⚠️ Could not determine page structure, defaulting to reader');
  return 'reader';
}

/**
 * Check if two structures are compatible for content-only transitions
 * Only exact same structures are compatible (home and user have different buttons)
 */
export function areStructuresCompatible(structure1, structure2) {
  // ONLY exact same structure is compatible
  // home and user are NOT compatible despite similar layouts (different buttons)
  return structure1 === structure2;
}

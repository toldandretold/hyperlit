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
export function areStructuresCompatible(structure1: any, structure2: any) {
  // ONLY exact same structure is compatible
  // home and user are NOT compatible despite similar layouts (different buttons)
  return structure1 === structure2;
}

/**
 * Get subdomain from hostname
 * Returns null for main domain, username for user subdomains
 */
export function getSubdomain(hostname = window.location.hostname) {
  // Handle localhost and IP addresses
  if (hostname === 'localhost' || hostname.match(/^\d+\.\d+\.\d+\.\d+$/)) {
    return null;
  }

  const parts = hostname.split('.');

  // For hyperlit.test, no subdomain
  // For sam.hyperlit.test, subdomain is 'sam'
  if (parts.length > 2) {
    return parts[0];
  }

  return null;
}

/**
 * Get book ID from URL based on subdomain context and path pattern
 */
export function getBookIdFromUrl(url = window.location.href) {
  const parsedUrl = new URL(url, window.location.origin);
  const subdomain = getSubdomain(parsedUrl.hostname);
  const path = parsedUrl.pathname;

  // User subdomain root = username is the book
  if (subdomain && path === '/') {
    return subdomain;
  }

  // Main domain root = most-recent
  if (!subdomain && path === '/') {
    return 'most-recent';
  }

  const pathSegments = path.split('/').filter(Boolean);

  // /u/{username} → username is the book
  if (pathSegments[0] === 'u' && pathSegments.length >= 2) {
    return pathSegments[1];
  }

  // Standalone sub-book routes (e.g., /Accumulation/AIreview)
  if (pathSegments.length >= 2 && pathSegments[1] === 'AIreview') {
    return `${pathSegments[0]}/${pathSegments[1]}`;
  }

  // /{book} or /{book}/HL_xxx → first segment is the book
  return pathSegments[0] || 'most-recent';
}

/**
 * Hypercite Utility Functions
 *
 * Pure helper functions with no side effects.
 * These functions perform data transformations, validation, and parsing.
 */

/**
 * Generate a unique hypercite ID
 * @returns {string} - A unique hypercite ID (e.g., "hypercite_x7k2pq9")
 */
export function generateHyperciteID() {
  return "hypercite_" + Math.random().toString(36).substring(2, 9);
}

/**
 * Parse hypercite href URL to extract components
 * @param {string} href - The href URL to parse
 * @returns {Object|null} - Object with citationIDa, hyperciteIDa, booka, or null if parsing fails
 */
export function parseHyperciteHref(href) {
  try {
    const url = new URL(href, window.location.origin);
    const booka = url.pathname.replace(/^\//, ""); // e.g., "booka"
    const hyperciteIDa = url.hash.substr(1);       // e.g., "hyperciteIda"
    const citationIDa = `/${booka}#${hyperciteIDa}`; // e.g., "/booka#hyperciteIda"
    return { citationIDa, hyperciteIDa, booka };
  } catch (error) {
    console.error("Error parsing hypercite href:", href, error);
    return null;
  }
}

/**
 * Extract hypercite ID from href URL
 * @param {string} hrefUrl - The href URL
 * @returns {string|null} - The hypercite ID or null if not found
 */
export function extractHyperciteIdFromHref(hrefUrl) {
  try {
    const url = new URL(hrefUrl, window.location.origin);
    const hash = url.hash;

    if (hash && hash.startsWith('#hypercite_')) {
      return hash.substring(1); // Remove the # symbol
    }

    return null;
  } catch (error) {
    console.error("Error parsing href URL:", hrefUrl, error);
    return null;
  }
}

/**
 * Determine relationship status based on citedIN array length
 * @param {number} citedINLength - Length of the citedIN array
 * @returns {string} - The relationship status ("single", "couple", or "poly")
 */
export function determineRelationshipStatus(citedINLength) {
  if (citedINLength === 0) {
    return "single";
  } else if (citedINLength === 1) {
    return "couple";
  } else {
    return "poly";
  }
}

/**
 * Remove a citedIN entry that matches the given hypercite element ID
 * @param {Array} citedINArray - The current citedIN array
 * @param {string} hyperciteElementId - The ID of the hypercite element to remove
 * @returns {Array} - Updated citedIN array with the entry removed
 */
export function removeCitedINEntry(citedINArray, hyperciteElementId) {
  if (!Array.isArray(citedINArray)) {
    return [];
  }

  return citedINArray.filter(citedINUrl => {
    // Extract the hypercite ID from the citedIN URL
    const urlParts = citedINUrl.split('#');
    if (urlParts.length > 1) {
      const citedHyperciteId = urlParts[1];
      return citedHyperciteId !== hyperciteElementId;
    }
    return true; // Keep entries that don't match the expected format
  });
}

/**
 * Find the nearest parent element with a numerical ID (e.g., "1", "2.1")
 * @param {HTMLElement} element - The starting element
 * @returns {HTMLElement|null} - The parent with numerical ID, or null if not found
 */
export function findParentWithNumericalId(element) {
  let current = element;
  while (current) {
    const id = current.getAttribute("id");
    if (id && /^\d+(?:\.\d+)?$/.test(id)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * Check if a selection spans multiple nodes with numerical IDs
 * @param {Range} range - The selection range to check
 * @returns {boolean} - True if selection spans multiple nodes, false otherwise
 */
export function selectionSpansMultipleNodes(range) {
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: function(node) {
        // Only accept nodes that have a numerical ID and intersect with our range
        if (node.id && /^\d+(?:\.\d+)?$/.test(node.id)) {
          if (range.intersectsNode(node)) {
            return NodeFilter.FILTER_ACCEPT;
          }
        }
        return NodeFilter.FILTER_SKIP;
      }
    }
  );

  let nodeCount = 0;
  while (walker.nextNode()) {
    nodeCount++;
    if (nodeCount > 1) {
      return true; // Found more than one node, so it spans multiple
    }
  }

  return false; // Single node or no nodes
}

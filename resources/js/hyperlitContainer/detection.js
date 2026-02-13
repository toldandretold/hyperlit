/**
 * Content Type Detection
 * Identifies what types of hyperlit content are present on clicked elements
 * Supports: footnotes, citations, hypercite-citations, highlights, hypercites
 */

import { openDatabase } from '../indexedDB/index.js';

/**
 * Detect all content types present on an element
 * @param {HTMLElement} element - The element to analyze
 * @param {Array} providedHighlightIds - Optional highlight IDs if already known
 * @param {string} directHyperciteId - Optional direct hypercite ID
 * @param {IDBDatabase} db - Reused database connection
 * @returns {Promise<Array>} Array of content type objects
 */
export async function detectContentTypes(element, providedHighlightIds = null, directHyperciteId = null, db = null) {
  const contentTypes = [];

  // 1. Check for footnotes (highest priority)
  const footnoteData = detectFootnote(element);
  if (footnoteData) {
    contentTypes.push(footnoteData);
  }

  // 2. Check for citations
  const citationData = detectCitation(element);
  if (citationData) {
    contentTypes.push(citationData);
  }

  // 3. Check for hypercite citation links (links pointing TO hypercites)
  const hyperciteCitationData = detectHyperciteCitation(element);
  if (hyperciteCitationData) {
    contentTypes.push(hyperciteCitationData);
  }

  // 4. Check for hyperlights
  const highlightData = await detectHighlights(element, providedHighlightIds, db);
  if (highlightData) {
    contentTypes.push(highlightData);
  }

  // 5. Check for hypercites (source hypercites)
  const hyperciteData = await detectHypercites(element, directHyperciteId, db);
  if (hyperciteData) {
    contentTypes.push(hyperciteData);
  }

  return contentTypes;
}

/**
 * Detect footnote content
 * Supports both formats:
 * - New: <sup fn-count-id="1" id="Fn..." class="footnote-ref">1</sup>
 * - Old: <sup fn-count-id="1" id="..."><a class="footnote-ref" href="#...">1</a></sup>
 *
 * @param {HTMLElement} element - The element to check
 * @returns {Object|null} Footnote data or null
 */
export function detectFootnote(element) {
  // Check if element is a sup with fn-count-id (handles both new and old format)
  if (element.tagName === 'SUP' && element.hasAttribute('fn-count-id')) {
    // New format: sup.id directly contains footnoteId
    // Old format fallback: get from anchor href
    const footnoteId = element.id || element.querySelector('a.footnote-ref, a[href^="#"]')?.href?.split('#')[1] || null;

    return {
      type: 'footnote',
      element: element,
      fnCountId: element.getAttribute('fn-count-id'),
      footnoteId: footnoteId
    };
  }

  // Old format: footnote link inside a sup (backwards compatibility)
  if (element.tagName === 'A' && element.classList.contains('footnote-ref')) {
    const supElement = element.closest('sup[fn-count-id]');
    if (supElement) {
      const footnoteId = supElement.id || element.href?.split('#')[1] || null;

      return {
        type: 'footnote',
        element: supElement,
        fnCountId: supElement.getAttribute('fn-count-id'),
        footnoteId: footnoteId
      };
    }
  }

  // Fallback - check if element is inside or contains a footnote sup
  // This handles the case where mark wraps around sup and mark handler fires
  const supElement = element.closest('sup[fn-count-id]') || element.querySelector('sup[fn-count-id]');
  if (supElement) {
    const footnoteId = supElement.id || supElement.querySelector('a.footnote-ref, a[href^="#"]')?.href?.split('#')[1] || null;
    return {
      type: 'footnote',
      element: supElement,
      fnCountId: supElement.getAttribute('fn-count-id'),
      footnoteId: footnoteId
    };
  }

  return null;
}

/**
 * Detect citation content
 * Supports both formats:
 * - Old: <a class="in-text-citation" href="#...">
 * - New: <a id="Ref..." class="citation-ref" href="/book#Ref...">Year</a>
 *
 * @param {HTMLElement} element - The element to check
 * @returns {Object|null} Citation data or null
 */
export function detectCitation(element) {
  // Check if element is an old-style citation link
  if (element.tagName === 'A' && element.classList.contains('in-text-citation')) {
    const href = element.getAttribute('href');
    if (href && href.startsWith('#')) {
      return {
        type: 'citation',
        element: element,
        referenceId: href.substring(1)
      };
    }
  }

  // Check if element is a new-style citation link (Ref ID format)
  if (element.tagName === 'A' && element.id && element.id.startsWith('Ref')) {
    return {
      type: 'citation',
      element: element,
      referenceId: element.id
    };
  }

  // Check if element has class="citation-ref"
  if (element.tagName === 'A' && element.classList.contains('citation-ref')) {
    const referenceId = element.id || null;
    if (referenceId) {
      return {
        type: 'citation',
        element: element,
        referenceId: referenceId
      };
    }
  }

  // Also check if we're inside an old-style citation element
  const parentCitation = element.closest('a.in-text-citation');
  if (parentCitation) {
    const href = parentCitation.getAttribute('href');
    if (href && href.startsWith('#')) {
      return {
        type: 'citation',
        element: parentCitation,
        referenceId: href.substring(1)
      };
    }
  }

  // Also check if we're inside a new-style citation element
  const parentRefCitation = element.closest('a.citation-ref, a[id^="Ref"]');
  if (parentRefCitation && parentRefCitation.id) {
    return {
      type: 'citation',
      element: parentRefCitation,
      referenceId: parentRefCitation.id
    };
  }

  return null;
}

/**
 * Detect highlight content
 * @param {HTMLElement} element - The element to check
 * @param {Array} providedHighlightIds - Optional pre-provided highlight IDs
 * @param {IDBDatabase} db - Reused database connection (unused here but kept for consistency)
 * @returns {Promise<Object|null>} Highlight data or null
 */
export async function detectHighlights(element, providedHighlightIds = null, db = null) {
  let highlightIds = providedHighlightIds;
  let highlightElement = element;

  // If not provided, extract from element classes or parent mark element
  if (!highlightIds) {
    if (element.tagName === 'MARK') {
      highlightIds = Array.from(element.classList).filter(cls => cls.startsWith('HL_'));
    } else {
      // Check if this element is inside a mark with highlight classes
      const parentMark = element.closest('mark');
      if (parentMark) {
        highlightIds = Array.from(parentMark.classList).filter(cls => cls.startsWith('HL_'));
        highlightElement = parentMark;
      } else {
        // Check if there are mark elements inside this element
        const childMark = element.querySelector('mark');
        if (childMark) {
          highlightIds = Array.from(childMark.classList).filter(cls => cls.startsWith('HL_'));
          highlightElement = childMark;
        }
      }
    }
  }

  if (!highlightIds || highlightIds.length === 0) {
    return null;
  }

  return {
    type: 'highlight',
    element: highlightElement,
    highlightIds: highlightIds
  };
}

/**
 * Detect hypercite citation links (links pointing TO hypercites in other documents)
 * @param {HTMLElement} element - The element to check
 * @returns {Object|null} Hypercite citation data or null
 */
export function detectHyperciteCitation(element) {
  // Check if element is an <a> tag with href containing #hypercite_
  if (element.tagName === 'A' && element.href) {
    const url = new URL(element.href, window.location.origin);
    const hash = url.hash;

    if (hash && hash.startsWith('#hypercite_')) {
      const hyperciteId = hash.substring(1); // Remove #
      const targetBookPath = url.pathname;
      const targetBook = targetBookPath.split('/').filter(p => p).pop(); // Get last path segment

      return {
        type: 'hypercite-citation',
        element: element,
        targetBook: targetBook,
        targetHyperciteId: hyperciteId,
        targetUrl: element.href
      };
    }
  }

  // Also check if we're inside a hypercite citation link
  const parentLink = element.closest('a[href*="#hypercite_"]');
  if (parentLink) {
    const url = new URL(parentLink.href, window.location.origin);
    const hash = url.hash;

    if (hash && hash.startsWith('#hypercite_')) {
      const hyperciteId = hash.substring(1);
      const targetBookPath = url.pathname;
      const targetBook = targetBookPath.split('/').filter(p => p).pop();

      return {
        type: 'hypercite-citation',
        element: parentLink,
        targetBook: targetBook,
        targetHyperciteId: hyperciteId,
        targetUrl: parentLink.href
      };
    }
  }

  return null;
}

/**
 * Detect hypercite content
 * @param {HTMLElement} element - The element to check
 * @param {string} directHyperciteId - Optional direct hypercite ID
 * @param {IDBDatabase} db - Reused database connection
 * @returns {Promise<Object|null>} Hypercite data or null
 */
export async function detectHypercites(element, directHyperciteId = null, db = null) {
  let hyperciteElement = null;
  let hyperciteIdFromElement = null;
  let relationshipStatus = 'single'; // Default to single
  let cachedData = null; // 🚀 Cache full hypercite data to avoid re-querying

  if (directHyperciteId) {
    hyperciteIdFromElement = directHyperciteId;
    hyperciteElement = document.getElementById(directHyperciteId); // Try to find it
  } else {
    // Existing logic to find hypercite element from click
    if (element.tagName === 'U' && (element.classList.contains('couple') || element.classList.contains('poly') || element.classList.contains('single'))) {
      hyperciteElement = element;
    } else {
      const parentHypercite = element.closest('u.couple, u.poly, u.single');
      if (parentHypercite) {
        hyperciteElement = parentHypercite;
      } else {
        const childHypercite = element.querySelector('u.couple, u.poly, u.single');
        if (childHypercite) {
          hyperciteElement = childHypercite;
        }
      }
    }
    if (hyperciteElement) {
      hyperciteIdFromElement = hyperciteElement.id;
    }
  }

  if (hyperciteIdFromElement) {
    let hyperciteIds = [];
    let primaryHyperciteId = hyperciteIdFromElement;

    // Check if this is an overlapping hypercite
    if (hyperciteElement && hyperciteElement.id === 'hypercite_overlapping' && hyperciteElement.hasAttribute('data-overlapping')) {
      // Extract actual hypercite IDs from data-overlapping attribute
      const overlappingData = hyperciteElement.getAttribute('data-overlapping');
      hyperciteIds = overlappingData.split(',').map(id => id.trim());

      // For overlapping hypercites, we need to determine which hypercite to use as primary
      // Use the first one as primary for data-content-id purposes
      primaryHyperciteId = hyperciteIds[0];

      console.log(`🔄 Detected overlapping hypercite with IDs: ${JSON.stringify(hyperciteIds)}, using primary: ${primaryHyperciteId}`);
    } else if (hyperciteElement && hyperciteElement.hasAttribute('data-overlapping')) {
      // Regular overlapping case
      hyperciteIds = hyperciteElement.getAttribute('data-overlapping').split(',').map(id => id.trim());
      primaryHyperciteId = hyperciteIds[0];
    } else {
      // Single hypercite
      hyperciteIds = [hyperciteIdFromElement];
      primaryHyperciteId = hyperciteIdFromElement;
    }

    // Determine relationshipStatus:
    // 1. From DOM element classes if available
    if (hyperciteElement) {
      if (hyperciteElement.classList.contains('couple')) {
        relationshipStatus = 'couple';
      } else if (hyperciteElement.classList.contains('poly')) {
        relationshipStatus = 'poly';
      } else if (hyperciteElement.classList.contains('single')) {
        relationshipStatus = 'single';
      }
    }
    // 2. Fallback to IndexedDB if element not found or no class found on element
    if (!hyperciteElement || (relationshipStatus === 'single' && !hyperciteElement.classList.contains('single'))) {
      // 🔍 PERFORMANCE LOG: This should rarely happen - log when defensive fallback triggers
      console.warn(`⚠️ DEFENSIVE DB FALLBACK triggered for hypercite ${primaryHyperciteId}. Element: ${!!hyperciteElement}, Status: ${relationshipStatus}`);

      // Use provided db or open new one
      const database = db || await openDatabase();
      const tx = database.transaction("hypercites", "readonly");
      const store = tx.objectStore("hypercites");
      const index = store.index("hyperciteId");
      const req = index.get(primaryHyperciteId);
      const result = await new Promise((resolve) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
      if (result && result.relationshipStatus) {
        relationshipStatus = result.relationshipStatus;
        cachedData = result; // 🚀 Cache the data for reuse
      }
    }

    return {
      type: 'hypercite',
      element: hyperciteElement, // May be null if directHyperciteId was used and element not found
      hyperciteId: primaryHyperciteId, // Use primary hypercite ID instead of element ID
      hyperciteIds: hyperciteIds,
      relationshipStatus: relationshipStatus,
      cachedData: cachedData // 🚀 Pass cached data forward to avoid re-querying
    };
  }

  return null;
}

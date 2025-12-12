/**
 * Transform Helpers
 * Shared utility functions for DOM transformation across format processors
 * Reduces code duplication in journal-specific processors (Sage, Springer, etc.)
 */

import { unwrap, wrapLooseNodes, isReferenceSectionHeading } from './dom-utils.js';

/**
 * Unwrap container elements (div, article, section, etc.) from DOM
 * Wraps loose text nodes in paragraphs before unwrapping
 * Processes in reverse order to handle nested containers correctly
 *
 * @param {HTMLElement} dom - DOM element to process
 * @param {string} additionalSelectors - Additional selectors to unwrap (e.g., 'ul, ol')
 */
export function unwrapContainers(dom, additionalSelectors = '') {
  const baseSelectors = 'div, article, section, main, header, footer, aside, nav, button';
  const selectors = additionalSelectors ? `${baseSelectors}, ${additionalSelectors}` : baseSelectors;

  const containers = Array.from(dom.querySelectorAll(selectors));

  // Process in reverse order (children before parents)
  containers.reverse().forEach(container => {
    wrapLooseNodes(container);
    unwrap(container);
  });

  // Also unwrap <font> tags
  dom.querySelectorAll('font').forEach(unwrap);
}

/**
 * Remove sections from DOM based on heading text matching
 * Removes the heading and all following content until the next heading
 *
 * @param {HTMLElement} dom - DOM element to process
 * @param {Function} headingMatcher - Function to test heading text (default: isReferenceSectionHeading)
 * @returns {number} - Number of sections removed
 */
export function removeSectionsByHeading(dom, headingMatcher = isReferenceSectionHeading) {
  const headings = dom.querySelectorAll('h1, h2, h3, h4, h5, h6');
  let removedCount = 0;

  headings.forEach(heading => {
    if (headingMatcher(heading.textContent.trim())) {
      let nextElement = heading.nextElementSibling;
      heading.remove();
      removedCount++;

      // Remove all content until next heading or end
      while (nextElement) {
        const next = nextElement.nextElementSibling;
        if (nextElement.tagName && /^H[1-6]$/.test(nextElement.tagName)) {
          break; // Hit another heading, stop
        }
        nextElement.remove();
        nextElement = next;
      }
    }
  });

  return removedCount;
}

/**
 * Remove elements with data-static-content attribute
 * These are sections that have already been extracted and will be re-appended
 *
 * @param {HTMLElement} dom - DOM element to process
 * @returns {number} - Number of elements removed
 */
export function removeStaticContentElements(dom) {
  const staticElements = dom.querySelectorAll('[data-static-content]');
  const count = staticElements.length;
  staticElements.forEach(el => el.remove());
  return count;
}

/**
 * Clone an element and clean it by stripping styles and optionally removing elements
 * Used during footnote/reference extraction to avoid modifying the original DOM
 *
 * @param {HTMLElement} element - Element to clone
 * @param {Array<string>} selectorsToRemove - CSS selectors for elements to remove from clone
 * @returns {HTMLElement} - Cleaned clone
 */
export function cloneAndClean(element, selectorsToRemove = []) {
  const clone = element.cloneNode(true);

  // Strip all inline styles
  clone.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));

  // Remove specified elements
  if (selectorsToRemove.length > 0) {
    clone.querySelectorAll(selectorsToRemove.join(', ')).forEach(el => el.remove());
  }

  return clone;
}

/**
 * Check if text looks like a valid bibliographic reference
 * Validates presence of year and minimum length
 *
 * @param {string} text - Text content to validate
 * @param {Object} options - Validation options
 * @param {number} options.minLength - Minimum text length (default: 20)
 * @param {number} options.maxYearPosition - Maximum position of year in text (default: 150)
 * @returns {boolean} - True if text appears to be a valid reference
 */
export function isValidReference(text, options = {}) {
  const { minLength = 20, maxYearPosition = 150 } = options;

  if (!text || text.length < minLength) {
    return false;
  }

  const yearMatch = text.match(/\d{4}[a-z]?/);
  return yearMatch && yearMatch.index < maxYearPosition;
}

/**
 * Add a reference to array only if not already present (avoids duplicates)
 *
 * @param {Array} references - Array of reference objects
 * @param {Object} newRef - New reference object to add
 * @param {string} keyField - Field to use for duplicate comparison (default: 'originalText')
 * @returns {boolean} - True if reference was added, false if duplicate
 */
export function addUniqueReference(references, newRef, keyField = 'originalText') {
  if (!references.find(r => r[keyField] === newRef[keyField])) {
    references.push(newRef);
    return true;
  }
  return false;
}

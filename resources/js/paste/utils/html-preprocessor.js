/**
 * HTML Preprocessor Utility
 * Cleans and normalizes HTML content before processing
 *
 * Features:
 * - Strips JavaScript links
 * - Removes fake citation links
 * - Preserves real HTTP/HTTPS links
 * - Removes unnecessary styling elements
 * - Prepares <sup> tags for footnote extraction
 *
 * Part of the modular paste processor system.
 */

/**
 * Check if a URL is a real link (not javascript or invalid)
 * @param {string} href - URL to check
 * @returns {boolean} - True if real link, false otherwise
 */
export function isRealLink(href) {
  if (!href) return false;

  // Allow http/https links
  if (/^https?:\/\//i.test(href)) return true;

  // Allow valid internal links (# followed by actual ID, not javascript)
  if (/^#[a-zA-Z][\w-]*$/.test(href)) return true;

  // Reject javascript: links
  if (/^javascript:/i.test(href)) return false;

  // Reject empty hash or hash with only whitespace/special chars
  if (/^#\s*$/.test(href) || /^#[^\w]/.test(href)) return false;

  return false;
}

/**
 * Preprocess HTML content to clean it for better extraction
 * - Strip JavaScript links and convert to plain text
 * - Preserve real links (http://, https://, #actualId)
 * - Keep <sup> tags and heading tags
 * - Convert everything else to clean text for pattern matching
 *
 * @param {string} htmlContent - Raw HTML content
 * @returns {string} - Preprocessed HTML
 */
export function preprocessHTMLContent(htmlContent) {
  // NOTE: Using innerHTML here is safe because content is already sanitized
  // before reaching this function (sanitized in base-processor.js)
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;

  // 1. Handle citation links (including data-open, data-google-interstitial, etc.)
  const allLinks = tempDiv.querySelectorAll('a');
  allLinks.forEach(link => {
    const text = link.textContent.trim();
    const href = link.getAttribute('href');

    // Check if this is a citation-like link (contains year pattern or has citation data attributes)
    const isCitationLink = /\d{4}/.test(text) ||
                          link.hasAttribute('data-open') ||
                          link.hasAttribute('data-google-interstitial') ||
                          /\([^)]*\d{4}[^)]*\)/.test(text);

    if (isCitationLink) {
      // Unwrap the link by replacing it with its own children (usually just a text node).
      // This leaves the citation text in place for the next processing step.
      while (link.firstChild) {
        link.parentNode.insertBefore(link.firstChild, link);
      }
      link.remove();
    } else if (!href || href === '#' || href.startsWith('javascript:') || href === '') {
      // Handle empty/javascript links - just convert to text
      link.replaceWith(document.createTextNode(text));
    } else if (isRealLink(href)) {
      // Preserve real links by marking them
      link.setAttribute('data-real-link', 'true');
    } else {
      // Convert other fake links to spans
      const span = document.createElement('span');
      span.className = 'fake-link';
      span.innerHTML = link.innerHTML;
      link.replaceWith(span);
    }
  });

  // 3. Clean up unnecessary elements while preserving structure
  const elementsToClean = tempDiv.querySelectorAll('span:not(.citation-text):not(.fake-link), font, div:not(.footnotes)');
  elementsToClean.forEach(el => {
    // If it's just styling, unwrap it
    if (el.children.length === 0 || (!el.classList.length && !el.id)) {
      while (el.firstChild) {
        el.parentNode.insertBefore(el.firstChild, el);
      }
      el.remove();
    }
  });

  // 4. Ensure <sup> tags are properly formatted for footnote extraction
  const supTags = tempDiv.querySelectorAll('sup');
  supTags.forEach(sup => {
    const text = sup.textContent.trim();
    if (/^\d+$/.test(text)) {
      // Add fn-count-id if not present
      if (!sup.hasAttribute('fn-count-id')) {
        sup.setAttribute('fn-count-id', text);
      }

      // New format: add class to sup, no anchor needed
      // The actual footnote ID will be set by footnote-linker.js
      if (!sup.classList.contains('footnote-ref')) {
        sup.classList.add('footnote-ref');
      }

      // Remove any existing anchor, keep text content
      const existingLink = sup.querySelector('a');
      if (existingLink) {
        sup.textContent = text;
      }
    }
  });

  return tempDiv.innerHTML;
}

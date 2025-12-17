/**
 * Centralized DOMPurify Configuration
 *
 * SECURITY: Uses DOMPurify's secure defaults with targeted blocklist for XSS vectors.
 * Allows data-* attributes through for journal format processing.
 */

import DOMPurify from 'dompurify';

// Publisher-specific attributes that need to be preserved during paste processing
// These are non-standard attributes (not data-*) used by academic publishers
const ADD_ATTR = [
  'content-id',    // OUP footnote/citation linking
  'reveal-id',     // OUP citation modals
  'role',          // SAGE listitem references
  'aria-controls', // OUP author flyouts
  'aria-expanded', // OUP author flyouts
  'fn-count-id',   // Footnote click handler identifier
];

// Forbidden tags (dangerous elements) - blocklist approach
const FORBID_TAGS = [
  'script', 'iframe', 'object', 'embed', 'applet',
  'form', 'input', 'button', 'select', 'textarea',
  'style', 'link', 'meta', 'base',
  'svg', 'math', // SVG and MathML can contain XSS vectors
  'template', 'slot',
  'noscript', 'canvas',
];

// Explicitly forbidden attributes (XSS vectors)
const FORBID_ATTR = [
  // Event handlers
  'onerror', 'onload', 'onclick', 'onmouseover', 'onmouseout',
  'onmouseenter', 'onmouseleave', 'onmousedown', 'onmouseup',
  'onfocus', 'onblur', 'onchange', 'oninput', 'onsubmit',
  'onkeydown', 'onkeyup', 'onkeypress',
  'ondrag', 'ondrop', 'ondragover', 'ondragstart', 'ondragend',
  'onscroll', 'onresize', 'onwheel',
  'onanimationstart', 'onanimationend', 'onanimationiteration',
  'ontransitionend', 'onplay', 'onpause', 'onended',
  'onloadstart', 'onprogress', 'oncanplay', 'oncanplaythrough',
  'ontimeupdate', 'onseeking', 'onseeked', 'onvolumechange',
  'oncontextmenu', 'oncopy', 'oncut', 'onpaste',
  'onbeforeunload', 'onunload', 'onhashchange', 'onpopstate',
  'onstorage', 'onmessage', 'onoffline', 'ononline',
  'onshow', 'ontoggle', 'oninvalid', 'onreset', 'onsearch', 'onselect',
  'onabort', 'onauxclick', 'onbeforecopy', 'onbeforecut', 'onbeforepaste',
  // Style attribute - can contain XSS via url()
  'style',
];

/**
 * Sanitize HTML content using DOMPurify defaults + targeted XSS blocklist
 * @param {string} html - Raw HTML to sanitize
 * @returns {string} - Sanitized HTML
 */
export function sanitizeHtml(html) {
  if (!html) return '';

  const result = DOMPurify.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR,
    ADD_ATTR,               // Allow publisher-specific non-data attributes
    ALLOW_DATA_ATTR: true,  // Let data-* attributes through for journal formats
    KEEP_CONTENT: true,     // Keep text content of removed tags
  });

  // Only log when sanitization actually modified the content
  if (result !== html) {
    console.log('🛡️ SANITIZE: Content was modified');
    console.log('  INPUT (first 200 chars):', html.substring(0, 200));
    console.log('  OUTPUT (first 200 chars):', result.substring(0, 200));
  }

  return result;
}

/**
 * Hook to sanitize URLs - removes javascript:, data:, vbscript: URLs
 */
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'href' || data.attrName === 'src') {
    const value = data.attrValue.toLowerCase().trim();
    if (
      value.startsWith('javascript:') ||
      value.startsWith('vbscript:') ||
      value.startsWith('data:text/html') ||
      value.startsWith('data:application')
    ) {
      data.attrValue = '';
      data.keepAttr = false;
    }
  }
});

// Export config for cases where direct DOMPurify usage is needed
export const SANITIZE_CONFIG = {
  FORBID_TAGS,
  FORBID_ATTR,
  ADD_ATTR,
  ALLOW_DATA_ATTR: true,
  KEEP_CONTENT: true,
};

export default sanitizeHtml;

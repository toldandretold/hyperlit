/**
 * Footnote Linker Utility
 * Processes footnote references and links them to footnote definitions
 *
 * Handles patterns like:
 * - <sup>1</sup> tags
 * - [^1] markdown-style references
 * - Plain text footnote numbers after punctuation
 *
 * Part of the modular paste processor system.
 */

/**
 * Create a footnote sup element with standard format
 * Centralized to ensure consistent format across all processors
 *
 * @param {string} footnoteId - The unique footnote ID (e.g., "Fn1234567890_abc")
 * @param {string} displayNumber - The display number/identifier (e.g., "1", "2")
 * @returns {HTMLElement} - The configured sup element
 */
export function createFootnoteSupElement(footnoteId, displayNumber) {
  const sup = document.createElement('sup');
  sup.id = footnoteId;
  sup.setAttribute('fn-count-id', displayNumber);
  sup.className = 'footnote-ref';
  sup.textContent = displayNumber;
  return sup;
}

/**
 * Create footnote sup HTML string with standard format
 * Use when building HTML strings rather than DOM elements
 *
 * @param {string} footnoteId - The unique footnote ID
 * @param {string} displayNumber - The display number/identifier
 * @returns {string} - HTML string for the sup element
 */
export function createFootnoteSupHTML(footnoteId, displayNumber) {
  return `<sup fn-count-id="${displayNumber}" id="${footnoteId}" class="footnote-ref">${displayNumber}</sup>`;
}

/**
 * Process and link footnote references in pasted content
 * @param {string} htmlContent - HTML content containing footnote references
 * @param {Map} footnoteMappings - Map of footnote identifiers to {uniqueId, uniqueRefId}
 * @param {string} formatType - Format type identifier (e.g., 'oup', 'taylor-francis')
 * @returns {string} - HTML with linked footnote references
 */
export function processFootnoteReferences(htmlContent, footnoteMappings, formatType = 'general') {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;

  // Handle existing <sup> elements
  const supElements = tempDiv.querySelectorAll('sup');
  supElements.forEach(sup => {
    // Skip if inside static content (footnotes/bibliography sections)
    if (sup.closest('[data-static-content]')) {
      return;
    }

    // First check for <sup><a href="#fnN">N</a></sup> or <sup><a href="https://...#ftn1">N</a></sup> pattern
    const link = sup.querySelector('a[href]');
    if (link) {
      const href = link.getAttribute('href');
      // Extract fragment from URL (handles both #ftn1 and https://...#ftn1)
      const fragmentMatch = href.match(/#(?:_?ftn|fn|note|_edn)(\d+)$/i);
      if (fragmentMatch) {
        const identifier = fragmentMatch[1];
        if (footnoteMappings.has(identifier)) {
          const mapping = footnoteMappings.get(identifier);
          sup.id = mapping.uniqueId;
          sup.setAttribute('fn-count-id', identifier);
          sup.className = 'footnote-ref';
          sup.textContent = identifier; // Remove the anchor, keep just the number
          return;
        }
      }
    }

    // Standard pattern: <sup>N</sup> with plain numeric content
    const identifier = sup.textContent.trim();
    if (footnoteMappings.has(identifier)) {
      const mapping = footnoteMappings.get(identifier);
      // New format: <sup fn-count-id="1" id="footnoteId" class="footnote-ref">1</sup>
      sup.id = mapping.uniqueId;
      sup.setAttribute('fn-count-id', identifier);
      sup.className = 'footnote-ref';

      // Remove any existing anchor, keep only text content
      const existingLink = sup.querySelector('a');
      if (existingLink) {
        sup.textContent = identifier;
      }
    }
  });

  // Handle bare <a href="#ftnN">[N]</a> links (not wrapped in <sup>)
  // These need to be converted to <sup> elements
  const allAnchors = tempDiv.querySelectorAll('a[href]');
  let bareLinksConverted = 0;
  allAnchors.forEach(link => {
    // Skip if inside static content
    if (link.closest('[data-static-content]')) return;
    // Skip if already inside a sup
    if (link.closest('sup')) return;

    const href = link.getAttribute('href');
    const fragmentMatch = href.match(/#(?:_?ftn|fn|note|_edn)(\d+)$/i);
    if (!fragmentMatch) return;

    const identifier = fragmentMatch[1];
    if (footnoteMappings.has(identifier)) {
      const mapping = footnoteMappings.get(identifier);

      // Create a new <sup> element to replace the <a>
      const sup = document.createElement('sup');
      sup.id = mapping.uniqueId;
      sup.setAttribute('fn-count-id', identifier);
      sup.className = 'footnote-ref';
      sup.textContent = identifier;

      // Replace the link with the sup
      link.parentNode.replaceChild(sup, link);
      bareLinksConverted++;
    }
  });

  if (bareLinksConverted > 0) {
    console.log(`  - Converted ${bareLinksConverted} bare anchor footnote links to <sup> format`);
  }

  // Handle markdown-style references [^1]
  const walker = document.createTreeWalker(
    tempDiv,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  const textNodes = [];
  let node;
  while (node = walker.nextNode()) {
    if (node.parentElement && !['SCRIPT', 'STYLE', 'A', 'SUP'].includes(node.parentElement.tagName)) {
      // Skip if inside static content (footnotes/bibliography sections)
      if (node.parentElement.closest('[data-static-content]')) {
        continue;
      }
      textNodes.push(node);
    }
  }

  textNodes.forEach(textNode => {
    const text = textNode.textContent;
    const replacements = [];

    // Handle markdown-style references [^1] and [1] - improved pattern
    const footnoteRefPattern = /\[\^?(\d+)\]/g;

    let match;

    while ((match = footnoteRefPattern.exec(text)) !== null) {
      const identifier = match[1];

      // Skip if this looks like a footnote definition (followed by colon)
      const nextChar = text[match.index + match[0].length];
      if (nextChar === ':') continue;

      if (footnoteMappings.has(identifier)) {
        const mapping = footnoteMappings.get(identifier);
        // New format: <sup fn-count-id="1" id="footnoteId" class="footnote-ref">1</sup>
        const supHTML = `<sup fn-count-id="${identifier}" id="${mapping.uniqueId}" class="footnote-ref">${identifier}</sup>`;

        replacements.push({
          start: match.index,
          end: match.index + match[0].length,
          replacement: supHTML
        });
      }
    }

    // Handle plain text footnote numbers AFTER punctuation
    // SKIP for HTML formats where footnotes are already marked with <sup> tags
    // (Cambridge, OUP, Taylor & Francis, etc.)
    const skipPlainTextPattern = ['cambridge', 'oup', 'taylor-francis', 'sage'].includes(formatType);

    if (!skipPlainTextPattern) {
      // CONSERVATIVE pattern for plain-text footnote detection:
      // Only match small numbers (1-99) immediately after sentence-ending punctuation
      // when followed by a capital letter (new sentence) or end of text.
      // This avoids false positives like "Figure 2.", "Page 23.", "Section 5."
      const plainFootnotePattern = /([.!?])\s*(\d{1,2})(?=\s+[A-Z]|\s*$)/g;

      while ((match = plainFootnotePattern.exec(text)) !== null) {
        const identifier = match[2];
        const punctuation = match[1];
        const numericId = parseInt(identifier, 10);

        // Additional guards against false positives:
        // 1. Must have a matching footnote definition
        // 2. Must be a reasonable footnote number (1-99)
        // 3. Check context: avoid "in 2023." or similar year patterns
        // 4. Avoid section numbers like "3.2 Title" where digit precedes the period
        const contextBefore = text.substring(Math.max(0, match.index - 10), match.index);
        const looksLikeYear = /\b(in|since|by|from|until|after|before)\s*$/.test(contextBefore);
        const looksLikeSectionNumber = /\d$/.test(contextBefore); // Period preceded by digit = section number

        if (footnoteMappings.has(identifier) && numericId <= 99 && !looksLikeYear && !looksLikeSectionNumber) {
          const mapping = footnoteMappings.get(identifier);
          // New format: <sup fn-count-id="1" id="footnoteId" class="footnote-ref">1</sup>
          const supHTML = `${punctuation}<sup fn-count-id="${identifier}" id="${mapping.uniqueId}" class="footnote-ref">${identifier}</sup>`;

          replacements.push({
            start: match.index,
            end: match.index + match[0].length,
            replacement: supHTML
          });
        }
      }
    } else {
      console.log(`📝 Skipping plain text footnote pattern for ${formatType} format (footnotes already marked)`);
    }

    // Apply replacements in reverse order to maintain indices
    if (replacements.length > 0) {
      // Sort by start position descending
      replacements.sort((a, b) => b.start - a.start);

      let newHTML = text;
      replacements.forEach(repl => {
        newHTML = newHTML.substring(0, repl.start) + repl.replacement + newHTML.substring(repl.end);
      });

      const span = document.createElement('span');
      span.innerHTML = newHTML;
      textNode.parentNode.replaceChild(span, textNode);

      while (span.firstChild) {
        span.parentNode.insertBefore(span.firstChild, span);
      }
      span.remove();
    }
  });

  return tempDiv.innerHTML;
}

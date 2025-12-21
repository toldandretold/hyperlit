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

    const identifier = sup.textContent.trim();
    if (footnoteMappings.has(identifier)) {
      const mapping = footnoteMappings.get(identifier);
      // Canonical format: <sup fn-count-id="1" id="footnoteIdref"><a class="footnote-ref" href="#footnoteId">1</a></sup>
      sup.id = `${mapping.uniqueId}ref`;
      sup.setAttribute('fn-count-id', identifier);

      // Create or update link
      let link = sup.querySelector('a');
      if (!link) {
        link = document.createElement('a');
        link.textContent = identifier;
        sup.textContent = '';
        sup.appendChild(link);
      }

      link.href = `#${mapping.uniqueId}`;
      link.className = 'footnote-ref';
    }
  });

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
        // Canonical format: <sup fn-count-id="1" id="footnoteIdref"><a class="footnote-ref" href="#footnoteId">1</a></sup>
        const supHTML = `<sup fn-count-id="${identifier}" id="${mapping.uniqueId}ref"><a class="footnote-ref" href="#${mapping.uniqueId}">${identifier}</a></sup>`;

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
      // Pattern: punctuation followed by number (at word boundary or end of sentence)
      // This is for plain text/markdown where footnotes aren't pre-marked
      const plainFootnotePattern = /([.!?;,:])\s*(\d+)(?=\s|$|[.!?])/g;

      while ((match = plainFootnotePattern.exec(text)) !== null) {
        const identifier = match[2];
        const punctuation = match[1];

        if (footnoteMappings.has(identifier)) {
          const mapping = footnoteMappings.get(identifier);
          // Canonical format: <sup fn-count-id="1" id="footnoteIdref"><a class="footnote-ref" href="#footnoteId">1</a></sup>
          const supHTML = `${punctuation}<sup fn-count-id="${identifier}" id="${mapping.uniqueId}ref"><a class="footnote-ref" href="#${mapping.uniqueId}">${identifier}</a></sup>`;

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

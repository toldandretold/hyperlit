/**
 * Citation Linker Utility
 * Processes in-text citations and links them to bibliography references
 *
 * Handles patterns like:
 * - (Author, Year)
 * - (Author et al., Year)
 * - (Author Year: page)
 * - Multiple citations: (Author1, Year1; Author2, Year2)
 *
 * Part of the modular paste processor system.
 */

import { generateReferenceKeys } from './reference-key-generator.js';

/**
 * Process and link in-text citations in pasted content
 * @param {string} htmlContent - HTML content containing citations
 * @param {Map} referenceMappings - Map of citation keys to reference IDs
 * @param {Array} allReferences - Array of all reference objects (for fallback matching)
 * @param {string} formatType - Format type identifier (e.g., 'oup', 'taylor-francis')
 * @returns {string} - HTML with linked citations
 */
export function processInTextCitations(htmlContent, referenceMappings, allReferences = [], formatType = 'general') {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;

  // Taylor & Francis specific processing
  if (formatType === 'taylor-francis') {
    console.log(`📚 T&F: Processing in-text citations with ${referenceMappings.size} reference mappings`);
  }

  // Convert existing anchor-based citations
  // Handles both:
  // - Direct anchors: <a href="#ref7">
  // - Full URLs with fragments: <a href="https://example.com/page#ref7">
  let anchorLinksConverted = 0;
  const allAnchors = tempDiv.querySelectorAll('a[href]');

  allAnchors.forEach(link => {
    // Skip if inside static bibliography section
    if (link.closest('[data-static-content="bibliography"]')) return;
    // Skip if already a Hyperlit citation
    if (link.classList.contains('in-text-citation')) return;

    const href = link.getAttribute('href');
    if (!href) return;

    // Extract fragment identifier from href (works for both #ref7 and https://...#ref7)
    const fragmentMatch = href.match(/#([a-zA-Z][\w-]*)$/);
    if (!fragmentMatch) return;

    const anchorId = fragmentMatch[1];
    if (referenceMappings.has(anchorId)) {
      link.setAttribute('href', '#' + referenceMappings.get(anchorId));
      link.classList.add('in-text-citation');
      anchorLinksConverted++;
    }
  });

  if (anchorLinksConverted > 0) {
    console.log(`  - ✅ Converted ${anchorLinksConverted} anchor-based citations to Hyperlit format`);
  }

  // Find citation patterns (Author Year) or (Year)
  const walker = document.createTreeWalker(
    tempDiv,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  const textNodes = [];
  let node;
  while (node = walker.nextNode()) {
    // Skip if inside a link or script/style
    const parent = node.parentElement;
    if (parent && !['SCRIPT', 'STYLE', 'A'].includes(parent.tagName)) {
      // Skip if inside bibliography section (but allow footnotes section)
      const isStaticBibliography = parent.getAttribute('data-static-content') === 'bibliography'
        || parent.closest('[data-static-content="bibliography"]');

      if (isStaticBibliography) {
        continue;
      }

      textNodes.push(node);
    }
  }

  textNodes.forEach(textNode => {
    const text = textNode.textContent;
    const citationPattern = /\(([^)]*?\d{4}[^)]*?)\)/g;
    let match;
    const replacements = [];

    while ((match = citationPattern.exec(text)) !== null) {
      const citationBlock = match[1];
      const subCitations = citationBlock.split(/;\s*/);
      let linkedParts = [];

      subCitations.forEach((subCite, index) => {
        const trimmed = subCite.trim();
        if (!trimmed) return;

        // Handle indirect citations like (Cited in Smith, 2020)
        let processedCite = trimmed;
        const prefixes = ['Cited in ', 'Quoted in ', 'see ', 'e.g., ', 'cf. '];
        for (const prefix of prefixes) {
            if (processedCite.toLowerCase().startsWith(prefix.toLowerCase())) {
                processedCite = processedCite.substring(prefix.length);
                break;
            }
        }

        const keys = generateReferenceKeys(processedCite, text.substring(0, match.index), formatType);
        let linked = false;
        let referenceId = null; // To store the found ID

        for (const key of keys) {
          if (referenceMappings.has(key)) {
            referenceId = referenceMappings.get(key);
            linked = true;
            break;
          }
        }

        // Acronym fallback logic
        if (!linked) {
            const yearMatch = processedCite.match(/(\d{4}[a-z]?)/);
            const authorMatch = processedCite.match(/^([A-Z]{2,})/);

            if (yearMatch && authorMatch && allReferences.length > 0) {
                const year = yearMatch[1];
                const acronym = authorMatch[1];

                for (const reference of allReferences) {
                    if (reference.originalText.includes(year)) {
                        const authorPart = reference.originalText.split(year)[0];
                        const initials = authorPart.match(/\b[A-Z]/g)?.join('');

                        if (initials === acronym) {
                            referenceId = reference.referenceId;
                            linked = true;
                            break;
                        }
                    }
                }
            }
        }

        if (linked) {
            const yearMatch = processedCite.match(/(\d{4}[a-z]?)/);
            if (yearMatch) {
              const authorPart = processedCite.substring(0, yearMatch.index);
              const yearPart = yearMatch[1];
              const trailingPart = processedCite.substring(yearMatch.index + yearMatch[0].length);

              // Re-add the prefix if it was stripped, so it stays visible
              const originalPrefix = trimmed.substring(0, trimmed.length - processedCite.length);

              linkedParts.push(
                originalPrefix + authorPart,
                `<a href="#${referenceId}" class="in-text-citation">${yearPart}</a>`,
                trailingPart
              );
            } else {
              linkedParts.push(`<a href="#${referenceId}" class="in-text-citation">${trimmed}</a>`);
            }
        } else {
            linkedParts.push(trimmed);
        }

        if (index < subCitations.length - 1) linkedParts.push('; ');
      });

      replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        replacement: `(${linkedParts.join('')})`
      });
    }

    // Apply replacements in reverse order
    if (replacements.length > 0) {
      let newHTML = text;
      for (let i = replacements.length - 1; i >= 0; i--) {
        const repl = replacements[i];
        newHTML = newHTML.substring(0, repl.start) + repl.replacement + newHTML.substring(repl.end);
      }

      // Replace text node with HTML
      const span = document.createElement('span');
      span.innerHTML = newHTML;
      textNode.parentNode.replaceChild(span, textNode);

      // Unwrap the span
      while (span.firstChild) {
        span.parentNode.insertBefore(span.firstChild, span);
      }
      span.remove();
    }
  });

  return tempDiv.innerHTML;
}

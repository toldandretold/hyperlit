/**
 * OUP (Oxford University Press) Processor
 * Handles OUP content with content-id attributes
 *
 * Key features:
 * - Extracts footnotes from <div class="footnote" content-id="fn1">
 * - Extracts references from bibliography with content-id="bib*"
 * - Special author name handling: "Surname Firstname" format
 */

import { BaseFormatProcessor } from './base-processor.js';
import { isReferenceSectionHeading } from '../utils/dom-utils.js';
import {
  unwrapContainers,
  removeSectionsByHeading,
  removeStaticContentElements,
  reformatCitationLink
} from '../utils/transform-helpers.js';

export class OupProcessor extends BaseFormatProcessor {
  constructor() {
    super('oup');
  }

  /**
   * Extract footnotes from OUP structure
   * OUP uses <div class="footnote" content-id="fn1"> for footnotes
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of footnote objects
   */
  async extractFootnotes(dom, bookId) {
    const footnotes = [];

    console.log('📚 OUP: Looking for footnotes with content-id attributes');

    // Find footnotes with content-id="fn*"
    const footnoteElements = dom.querySelectorAll('.footnote[content-id^="fn"], [content-id^="fn"]');
    console.log(`📚 OUP: Found ${footnoteElements.length} footnote elements`);

    footnoteElements.forEach(element => {
      const contentId = element.getAttribute('content-id');

      // CHECK CONTEXT: Skip if in table/figure context (CRITICAL FIX)
      // Table/figure notes should stay in body, not be extracted to Notes section
      const inTableContext = element.closest('.table-wrap-foot, .table-wrap, table');
      const inFigureContext = element.closest('.fig, .fig-section, figure');

      if (inTableContext || inFigureContext) {
        console.log(`📚 OUP: Skipping ${contentId} (in ${inTableContext ? 'table' : 'figure'} context, will stay in body)`);
        return; // Don't extract, leave in place
      }

      // Extract number from content-id (e.g., "fn1" → "1", "fn-0100" → "0100")
      const identifierMatch = contentId.match(/fn-?(\d+)/);
      if (!identifierMatch) {
        console.warn(`⚠️ OUP: Could not extract identifier from content-id: ${contentId}`);
        return;
      }

      // Normalize identifier: "0001" → "1"
      const identifier = parseInt(identifierMatch[1], 10).toString();

      // Get content - drill down to actual text, not wrapper divs
      const contentClone = element.cloneNode(true);

      // Remove any backlinks or footnote labels
      contentClone.querySelectorAll('a[href*="#fn"], .footnote-label, .label').forEach(el => el.remove());

      // OUP structure: element > .footnote-content > p.footnote-compatibility
      // We want ONLY the paragraph content, not the wrapper divs with inline styles
      let contentElement = contentClone.querySelector('.footnote-content p, p.footnote-compatibility, p');

      if (!contentElement) {
        // Fallback: if no paragraph found, use entire content
        contentElement = contentClone;
        console.warn(`⚠️ OUP: No content paragraph found for footnote ${identifier}, using entire element`);
      }

      // Strip all inline styles from remaining elements
      contentElement.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));

      const htmlContent = contentElement.innerHTML.trim();

      if (htmlContent) {
        const footnote = this.createFootnote(
          this.generateFootnoteId(bookId, identifier),
          htmlContent,
          identifier,
          this.generateFootnoteRefId(bookId, identifier),
          'oup'
        );

        // Store the content-id for linking
        footnote.contentId = contentId;

        footnotes.push(footnote);

        console.log(`📚 OUP: Extracted footnote ${identifier} (${contentId}): "${htmlContent.substring(0, 50)}..."`);

        // Remove from DOM so it doesn't appear in main content
        element.remove();
      }
    });

    console.log(`📚 OUP: Extraction complete - ${footnotes.length} footnotes extracted`);

    return footnotes;
  }

  /**
   * Link footnotes to in-text references
   * OUP uses <a reveal-id="fn*"> for footnote references
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} footnotes - Array of footnote objects
   */
  linkFootnotes(dom, footnotes) {
    console.log(`📚 OUP: Linking ${footnotes.length} footnotes to in-text references`);

    // Find all OUP footnote reference links
    const fnLinks = dom.querySelectorAll('a[reveal-id^="fn"], a[data-open^="fn"]');
    let linkedCount = 0;

    fnLinks.forEach(link => {
      const revealId = link.getAttribute('reveal-id') || link.getAttribute('data-open');

      // Extract identifier from "fn11" → "11"
      const identifierMatch = revealId.match(/fn-?(\d+)/);
      if (!identifierMatch) {
        console.warn(`⚠️ OUP: Could not extract identifier from reveal-id: ${revealId}`);
        return;
      }

      // Normalize identifier: "0001" → "1"
      const identifier = parseInt(identifierMatch[1], 10).toString();
      const footnote = footnotes.find(fn => fn.originalIdentifier === identifier);

      if (footnote) {
        // Check if already wrapped in <sup>
        let sup = link.parentElement;
        if (sup.tagName !== 'SUP') {
          // Not wrapped - create <sup> wrapper
          sup = document.createElement('sup');
          link.parentNode.insertBefore(sup, link);
          sup.appendChild(link);
        }

        // Set sup ID for backlinking
        sup.id = footnote.refId;

        // Set fn-count-id attribute for click handler
        sup.setAttribute('fn-count-id', identifier);

        // Convert link attributes
        link.setAttribute('href', `#${footnote.footnoteId}`);
        link.setAttribute('class', 'footnote-ref');
        link.textContent = identifier; // Already normalized at extraction

        // Remove OUP-specific attributes
        link.removeAttribute('reveal-id');
        link.removeAttribute('data-open');
        link.removeAttribute('data-google-interstitial');

        linkedCount++;
      } else {
        console.warn(`⚠️ OUP: Could not find footnote for identifier ${identifier}`);
      }
    });

    console.log(`  - Linked ${linkedCount} OUP footnote references`);
  }

  /**
   * Extract references from OUP bibliography
   * OUP uses content-id="bib*" for bibliography entries
   * Special handling: bibliography format is "Surname Firstname"
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<Array>} - Array of reference objects
   */
  async extractReferences(dom, bookId) {
    const references = [];

    console.log('📚 OUP: Looking for bibliography items with content-id attributes');

    // Find bibliography items with content-id="bib*"
    const bibItems = dom.querySelectorAll('[content-id^="bib"]');
    console.log(`📚 OUP: Found ${bibItems.length} bibliography items`);

    bibItems.forEach(item => {
      const contentId = item.getAttribute('content-id');
      const fullText = item.textContent.trim();

      if (!fullText || fullText.length < 10) {
        console.warn(`⚠️ OUP: Skipping empty or too short bibliography item: ${contentId}`);
        return;
      }

      // OUP bibliography format variations:
      // 1. "Surname Firstname (Year). Title..."
      // 2. "Surname, Initial(s). (Year). Title..." - e.g., "Cribb, J. (2016)"
      // 3. "Surname, Initial(s). Year. Title..." - e.g., "Mirza-Davies, J. 2015." (no brackets)
      // 4. "Surname, Initial(s), Surname, Initial(s), and Surname, Initial(s). (Year)" - multiple authors
      // 5. "Hyphenated-Surname, Initial(s). (Year)" - e.g., "Mirza-Davies, J. (2015)"

      // Try bracketed year first: (2015)
      let yearMatch = fullText.match(/\((\d{4}[a-z]?)\)/);

      // If no brackets, try bare year after initials: ", J. 2015."
      if (!yearMatch) {
        yearMatch = fullText.match(/,\s*[A-Z]\.?\s*(\d{4}[a-z]?)[\.\s]/);
      }

      if (yearMatch) {
        const year = yearMatch[1];
        const beforeYear = fullText.substring(0, yearMatch.index).trim();

        let surname = null;
        const refKeys = [];

        // Pattern 1: "Surname, Initial(s)" - most common OUP format
        // Matches: "Cribb, J.", "Mirza-Davies, J.", "van der Berg, A."
        const commaInitialMatch = beforeYear.match(/^([A-Z][a-zA-Z'-]+(?:\s+(?:van|der|de|la|von))?[a-zA-Z'-]*),\s*[A-Z]/);
        if (commaInitialMatch) {
          surname = commaInitialMatch[1].trim();
          console.log(`📚 OUP: Pattern 1 (Surname, Initial) matched: "${surname}" from beforeYear: "${beforeYear}"`);
        } else {
          console.log(`📚 OUP: Pattern 1 failed to match beforeYear: "${beforeYear}"`);
        }

        // Pattern 2: "Surname Firstname" - simple format
        if (!surname) {
          const simpleMatch = beforeYear.match(/^([A-Z][a-zA-Z'-]+)\s+([A-Z][a-zA-Z']+)/);
          if (simpleMatch) {
            surname = simpleMatch[1];
            console.log(`📚 OUP: Pattern 2 (Surname Firstname) matched: "${surname}"`);
          }
        }

        // Pattern 3: Multi-author - extract first author before any comma or "and"
        if (!surname) {
          const multiAuthorMatch = beforeYear.match(/^([A-Z][a-zA-Z'-]+)/);
          if (multiAuthorMatch) {
            surname = multiAuthorMatch[1];
            console.log(`📚 OUP: Pattern 3 (Multi-author) matched: "${surname}"`);
          }
        }

        if (surname) {
          // Generate keys with hyphen and lowercase handling
          refKeys.push(surname.toLowerCase() + year); // Primary key: "cribb2016", "mirza-davies2015"

          // Also add key without hyphens for flexibility
          if (surname.includes('-')) {
            refKeys.push(surname.toLowerCase().replace(/-/g, '') + year);
          }

          const referenceId = refKeys[0];

          references.push({
            content: fullText,
            originalText: fullText,
            type: 'oup-bibliography',
            needsKeyGeneration: false,
            refKeys: refKeys,
            referenceId: referenceId,
            contentId: contentId
          });

          console.log(`📚 OUP: Extracted reference "${referenceId}" with keys: [${refKeys.join(', ')}]`);
        } else {
          // Fallback: use standard reference pattern
          references.push({
            content: fullText,
            originalText: fullText,
            type: 'oup-bibliography-fallback',
            needsKeyGeneration: true,
            contentId: contentId
          });

          console.log(`📚 OUP: Extracted reference (fallback pattern, will generate keys): "${fullText.substring(0, 60)}..."`);
        }
      } else {
        console.warn(`⚠️ OUP: No year found in bibliography item: "${fullText.substring(0, 60)}..."`);
      }
    });

    // Also look for .js-splitview-ref-item elements (alternative OUP pattern)
    const splitviewItems = dom.querySelectorAll('.js-splitview-ref-item');
    if (splitviewItems.length > 0) {
      console.log(`📚 OUP: Found ${splitviewItems.length} splitview reference items`);

      splitviewItems.forEach(item => {
        const fullText = item.textContent.trim();

        if (fullText && fullText.length > 10 && !references.find(r => r.content === fullText)) {
          references.push({
            content: fullText,
            originalText: fullText,
            type: 'oup-splitview',
            needsKeyGeneration: true
          });
        }
      });
    }

    console.log(`📚 OUP: Total references extracted: ${references.length}`);

    return references;
  }

  /**
   * Remove duplicate OUP tables (modal vs inline versions)
   * OUP provides .table-modal (for popup) and .table-full-width-wrap (inline)
   * Keep inline version, remove modal
   *
   * @param {HTMLElement} dom - DOM element
   */
  handleDuplicateTables(dom) {
    const modalContainers = dom.querySelectorAll('.table-modal');

    modalContainers.forEach(modalContainer => {
      // Remove the entire modal container
      modalContainer.remove();
      console.log('📚 OUP: Removed duplicate table modal');
    });
  }

  /**
   * Preserve table captions by extracting them from .table-wrap-title
   * Creates clean paragraph with "Table N. Caption text" format
   *
   * @param {HTMLElement} dom - DOM element
   */
  preserveTableCaptions(dom) {
    const tableWraps = dom.querySelectorAll('.table-wrap, .table-full-width-wrap');

    tableWraps.forEach(wrap => {
      const titleContainer = wrap.querySelector('.table-wrap-title');
      const label = wrap.querySelector('.label, .title-label');
      const caption = wrap.querySelector('.caption');
      const table = wrap.querySelector('table');

      if (label && caption && table) {
        // Extract label and caption text
        const labelText = label.textContent.trim();

        // Caption might be nested in a <p> tag
        const captionPara = caption.querySelector('p');
        const captionText = (captionPara ? captionPara.textContent : caption.textContent).trim();

        // Create a paragraph with label + caption
        const captionP = document.createElement('p');
        captionP.innerHTML = `<strong>${labelText}</strong> ${captionText}`;

        // Insert before the table
        table.parentNode.insertBefore(captionP, table);

        // Remove the original .table-wrap-title container to prevent duplication
        if (titleContainer) {
          titleContainer.remove();
        }

        console.log(`📚 OUP: Preserved table caption: "${labelText} ${captionText.substring(0, 40)}..."`);
      }
    });
  }

  /**
   * Preserve figure captions by extracting them from .graphic-bottom
   * Creates clean paragraph with "Fig. N. Caption text" format
   *
   * @param {HTMLElement} dom - DOM element
   */
  preserveFigureCaptions(dom) {
    // Only select .graphic-wrap to avoid duplicate processing
    // (OUP has nested .fig > .graphic-wrap structure)
    const graphicWraps = dom.querySelectorAll('.graphic-wrap');

    graphicWraps.forEach(wrap => {
      const label = wrap.querySelector('.fig-label, .label');
      const caption = wrap.querySelector('.fig-caption, .caption');
      const img = wrap.querySelector('img');

      if (label && caption && img) {
        // Extract label and caption text
        const labelText = label.textContent.trim();
        const captionText = caption.textContent.trim();

        // Create a paragraph with label + caption
        const captionP = document.createElement('p');
        captionP.innerHTML = `<strong>${labelText}</strong> ${captionText}`;

        // Insert before the image
        img.parentNode.insertBefore(captionP, img);

        // IMPORTANT: Remove the .graphic-bottom container to prevent duplication
        // after unwrapping (it contains the original label/caption we just extracted)
        const graphicBottom = wrap.querySelector('.graphic-bottom');
        if (graphicBottom) {
          graphicBottom.remove();
        }

        console.log(`📚 OUP: Preserved figure caption: "${labelText} ${captionText.substring(0, 40)}..."`);
      }
    });
  }

  /**
   * Remove original Footnotes and Bibliography sections from body
   * These sections are already extracted and will be appended as clean sections at the end
   * Prevents duplicate/mangled content in body
   *
   * @param {HTMLElement} dom - DOM element
   */
  removeExtractedSections(dom) {
    // PASS 1: Remove by heading text matching
    const removedSections = removeSectionsByHeading(dom, isReferenceSectionHeading);

    // PASS 2: Remove elements with data-static-content attribute
    const removedStatic = removeStaticContentElements(dom);

    console.log(`📚 OUP: Removed ${removedSections + removedStatic} extracted section(s) from body`);
  }

  /**
   * Transform structure - unwrap divs and clean up
   *
   * @param {HTMLElement} dom - DOM element
   * @param {string} bookId - Book identifier
   * @returns {Promise<void>}
   */
  async transformStructure(dom, bookId) {
    console.log('📚 OUP: Applying general structure transformation');

    // STEP 1: Remove duplicate tables FIRST (before unwrapping)
    this.handleDuplicateTables(dom);

    // STEP 1.5: Remove original extracted sections (Footnotes, Bibliography)
    // These were already extracted and will be appended as clean sections at the end
    this.removeExtractedSections(dom);

    // STEP 2: Preserve table and figure captions before removing UI elements
    this.preserveTableCaptions(dom);
    this.preserveFigureCaptions(dom);

    // STEP 3: Remove UI elements (buttons, links) from tables/figures
    // Note: Don't remove .graphic-bottom as it contains labels/captions we need
    const uiElements = dom.querySelectorAll('.js-view-large, .openInAnotherWindow, .download-slide, .table-open-button-wrap, .ajax-articleAbstract-exclude-regex, .figure-button-wrap');
    uiElements.forEach(el => el.remove());
    console.log(`📚 OUP: Removed ${uiElements.length} UI elements (buttons, links)`);

    // STEP 4: General container unwrapping
    unwrapContainers(dom);

    // STEP 5: Remove empty xrefLink spans that OUP inserts before citations
    const xrefLinks = dom.querySelectorAll('span.xrefLink');
    xrefLinks.forEach(span => {
      if (!span.textContent.trim()) {
        span.remove();
      }
    });
    console.log(`📚 OUP: Removed ${xrefLinks.length} empty xrefLink spans`);

    console.log(`📚 OUP: Transformation complete`);
  }

  /**
   * Override linkCitations to convert OUP-specific citation links
   * OUP uses <a reveal-id="CIT..." data-open="CIT..."> for citations
   *
   * @param {HTMLElement} dom - DOM element
   * @param {Array} references - Array of reference objects
   */
  linkCitations(dom, references) {
    // First, let base class generate reference IDs and build reference mappings
    super.linkCitations(dom, references);

    console.log('📚 OUP: Converting OUP-specific citation links...');

    // Find all OUP citation links (reveal-id or data-open attributes with CIT)
    const citationLinks = dom.querySelectorAll('a[reveal-id^="CIT"], a[data-open^="CIT"]');
    let convertedCount = 0;
    let failedCount = 0;

    citationLinks.forEach(link => {
      const citId = link.getAttribute('reveal-id') || link.getAttribute('data-open');
      const citText = link.textContent.trim();

      // Detect citation pattern
      let year, author, beforeYear, isNarrative = false, isSplitCitation = false;

      // First, check if this looks like "Author (Year" pattern
      const incompleteBracketMatch = citText.match(/^(.+?)\s*\((\d{4}[a-z]?)$/);
      if (incompleteBracketMatch) {
        // Could be incomplete narrative OR split citation
        // Check if next link (after comma) is another citation = SPLIT CITATION
        let nextNode = link.nextSibling;
        let foundNextCitation = false;

        // Skip whitespace/comma text nodes
        while (nextNode && nextNode.nodeType === Node.TEXT_NODE) {
          const text = nextNode.textContent.trim();
          if (text && !/^[,\s]+$/.test(text)) {
            break; // Hit non-citation text
          }
          nextNode = nextNode.nextSibling;
        }

        // Check if next element is another citation link
        if (nextNode && nextNode.nodeType === Node.ELEMENT_NODE) {
          const isNextCitation = nextNode.hasAttribute('reveal-id') ||
                                 nextNode.hasAttribute('data-open') ||
                                 (nextNode.tagName === 'A' && nextNode.classList.contains('in-text-citation'));
          if (isNextCitation) {
            const nextText = nextNode.textContent.trim();
            // If next citation is year-only, this is a SPLIT CITATION, not narrative
            if (/^\d{4}[a-z]?$/.test(nextText)) {
              foundNextCitation = true;
              isSplitCitation = true;
            }
          }
        }

        if (isSplitCitation) {
          // SPLIT CITATION: <a>Thatcher (1988</a>, <a>1996</a>)
          // Treat as parenthetical, not narrative
          author = incompleteBracketMatch[1].trim();
          year = incompleteBracketMatch[2];
          beforeYear = author + ' ('; // Include opening bracket in beforeYear
          console.log(`📚 OUP: Detected SPLIT CITATION: "${author} (${year}" followed by another year`);
        } else {
          // INCOMPLETE NARRATIVE: "Author (Year" (no following citation)
          author = incompleteBracketMatch[1].trim();
          year = incompleteBracketMatch[2];
          beforeYear = author + ' ';
          isNarrative = true;
          console.log(`📚 OUP: Detected incomplete narrative citation: "${author} (${year}" (missing closing bracket)`);
        }
      }
      // Pattern 2: COMPLETE NARRATIVE citation - "Lincoln (1854)"
      else {
        const narrativeMatch = citText.match(/^(.+?)\s*\((\d{4}[a-z]?)\)$/);
        if (narrativeMatch) {
          author = narrativeMatch[1].trim();
          year = narrativeMatch[2];
          beforeYear = author + ' ';
          isNarrative = true;
          console.log(`📚 OUP: Detected complete narrative citation: "${author} (${year})"`);
        }
      }

      if (!author && !year) {
        // Pattern 3: PARENTHETICAL citation - "Thatcher, 1981" or "Foa and Mounk, 2017"
        const yearMatch = citText.match(/\b(\d{4}[a-z]?)\b/);
        if (!yearMatch) {
          console.warn(`⚠️ OUP: Could not extract year from citation: "${citText}"`);
          failedCount++;
          return;
        }

        year = yearMatch[1];

        // Extract author name (everything before the year/comma)
        beforeYear = citText.substring(0, yearMatch.index).trim();
        if (beforeYear) {
          // Remove trailing comma, punctuation, or brackets
          author = beforeYear.replace(/[,\s()]+$/, '').trim();
        }

        // Handle sequential same-author citations: e.g., (Johansen, 1988, 1991)
        // If link text is year-only, inherit author from previous citation in same group
        if (!author && /^\d{4}[a-z]?$/.test(citText)) {
          console.log(`📚 OUP: Year-only citation "${citText}" - looking for previous citation to inherit author`);

          let prevNode = link.previousSibling;
          let foundPrevCitation = false;

          // Walk backwards through siblings
          while (prevNode && !foundPrevCitation) {
            if (prevNode.nodeType === Node.TEXT_NODE) {
              const text = prevNode.textContent;
              // Check if we're still in valid citation context (comma/whitespace only)
              if (text.trim() && !/^[,\s]+$/.test(text)) {
                // Hit non-citation text, stop searching
                console.log(`📚 OUP: Stopped search - hit non-citation text: "${text}"`);
                break;
              }
            } else if (prevNode.nodeType === Node.ELEMENT_NODE) {
              // Check if this is a previous OUP citation link
              // Could be unconverted (has reveal-id) OR already converted (has in-text-citation class)
              const isPrevOupCitation = prevNode.hasAttribute('reveal-id') ||
                                       prevNode.hasAttribute('data-open') ||
                                       (prevNode.tagName === 'A' && prevNode.classList.contains('in-text-citation'));

              if (isPrevOupCitation) {
                const prevCitText = prevNode.textContent.trim();
                const prevYearMatch = prevCitText.match(/\b(\d{4}[a-z]?)\b/);

                if (prevYearMatch) {
                  // For already-converted citations, text is just the year
                  // So we need to look at text BEFORE the link for the author
                  let extractedAuthor = null;

                  if (prevNode.classList.contains('in-text-citation')) {
                    // Already converted - author is in text node before this link
                    let authorNode = prevNode.previousSibling;
                    while (authorNode && authorNode.nodeType === Node.TEXT_NODE) {
                      const authorText = authorNode.textContent.trim();
                      if (authorText && !/^[,\s()]+$/.test(authorText)) {
                        // Found author text - extract name, removing trailing punctuation/brackets
                        extractedAuthor = authorText.replace(/[,\s()]+$/, '').trim();
                        break;
                      }
                      authorNode = authorNode.previousSibling;
                    }
                  } else {
                    // Not yet converted - author is in the link text itself
                    const prevBeforeYear = prevCitText.substring(0, prevYearMatch.index).trim();
                    if (prevBeforeYear) {
                      extractedAuthor = prevBeforeYear.replace(/[,\s()]+$/, '').trim();
                    }
                  }

                  if (extractedAuthor) {
                    author = extractedAuthor;
                    foundPrevCitation = true;
                    console.log(`📚 OUP: Inherited author "${author}" from previous citation (converted: ${prevNode.classList.contains('in-text-citation')})`);
                  }
                }
                break;
              }
            }
            prevNode = prevNode.previousSibling;
          }

          if (!foundPrevCitation) {
            console.log(`📚 OUP: No previous citation found to inherit author from`);
          }
        }
      }

      // Generate possible citation keys (same logic as generateRefKeys)
      const possibleKeys = [];
      if (author) {
        // Split on "and" for multiple authors, take first
        const firstAuthor = author.split(/\s+and\s+/i)[0].trim();

        // Clean author text: remove "et al.", "eds.", trailing commas, etc.
        let cleanAuthor = firstAuthor
          .replace(/\s+et\s+al\.?/gi, '')     // Remove "et al." or "et al"
          .replace(/\s+eds?\.?$/gi, '')       // Remove trailing "ed." or "eds."
          .replace(/,\s*$/g, '')              // Remove trailing comma
          .trim();

        // Take last word as surname
        const words = cleanAuthor.split(/\s+/);
        const surname = words[words.length - 1];
        possibleKeys.push(surname.toLowerCase() + year);

        // Also try without hyphens for flexibility (e.g., "Mirza-Davies" vs "MirzaDavies")
        if (surname.includes('-')) {
          possibleKeys.push(surname.toLowerCase().replace(/-/g, '') + year);
        }

        console.log(`📚 OUP: Citation "${citText}" → firstAuthor: "${firstAuthor}" → cleanAuthor: "${cleanAuthor}" → surname: "${surname}" → keys: [${possibleKeys.slice(0, 2).join(', ')}]`);

        // Also try full author name (cleaned)
        possibleKeys.push(cleanAuthor.toLowerCase().replace(/\s+/g, '') + year);
      }
      // Also try just the year
      possibleKeys.push(year.toLowerCase());

      // Try to find a matching reference
      let matchedReference = null;
      for (const reference of references) {
        if (reference.refKeys) {
          for (const key of possibleKeys) {
            if (reference.refKeys.includes(key)) {
              matchedReference = reference;
              break;
            }
          }
        }
        if (matchedReference) break;
      }

      if (matchedReference && matchedReference.referenceId) {
        // Convert to proper citation link
        link.setAttribute('href', `#${matchedReference.referenceId}`);
        link.setAttribute('class', 'in-text-citation');

        // Get trailing text after year (only for parenthetical)
        const afterYearPos = citText.indexOf(year) + year.length;
        const trailing = isNarrative ? '' : citText.substring(afterYearPos);

        // Use shared utility for citation reformatting
        reformatCitationLink(link, {
          author: beforeYear || '',
          year,
          isNarrative,
          trailing
        });

        // Remove ALL OUP-specific attributes
        link.removeAttribute('reveal-id');
        link.removeAttribute('data-open');
        link.removeAttribute('data-google-interstitial');

        convertedCount++;
      } else {
        console.warn(`⚠️ OUP: Could not find reference for "${citText}" (${citId}), tried keys:`, possibleKeys);
        failedCount++;
      }
    });

    console.log(`  - Converted ${convertedCount} OUP citation links, ${failedCount} failed`);
  }
}

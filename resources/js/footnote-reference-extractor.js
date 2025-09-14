// footnote-reference-extractor.js - Extract footnotes and references from pasted content
import { openDatabase } from './cache-indexedDB.js';

// ========================================================================
// FOOTNOTE EXTRACTION SYSTEM
// ========================================================================

/**
 * Extract footnotes from HTML content - specifically for HTML pastes
 */
function extractFootnotesFromHTML(htmlContent, bookId, formatType = 'general') {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;
  
  const footnotes = [];
  const footnoteMappings = new Map();
  
  console.log(`📝 Extracting footnotes using ${formatType} format strategy`);

  // --- MARKDOWN FOOTNOTE HANDLING (for markdown converted to HTML) ---
  // First, find all [^1] and [1] references in text to know what footnotes we need
  const allTextContent = tempDiv.textContent;
  const footnoteRefs = new Set();
  const refPattern = /\[\^?(\d+)\]/g;
  let refMatch;
  while ((refMatch = refPattern.exec(allTextContent)) !== null) {
    footnoteRefs.add(refMatch[1]);
  }
  
  if (footnoteRefs.size > 0) {
    console.log(`📝 Found markdown footnote references: [${Array.from(footnoteRefs).join(', ')}]`);
    
    // Look for footnote definitions [^1]: content in paragraphs
    const allParagraphs = tempDiv.querySelectorAll('p');
    allParagraphs.forEach(p => {
      const text = p.textContent.trim();
      
      // Match patterns like [^1]: content or [1]: content at the start of paragraphs
      const markdownFootnoteMatch = text.match(/^\[\^?(\d+)\]\s*:\s*(.+)$/s);
      
      if (markdownFootnoteMatch) {
        const identifier = markdownFootnoteMatch[1];
        const content = markdownFootnoteMatch[2].trim();
        
        console.log(`📝 FOUND markdown footnote definition: [^${identifier}]: ${content.substring(0, 50)}...`);
        
        if (identifier && content) {
          const uniqueId = `${bookId}Fn${Date.now()}${identifier}`;
          const uniqueRefId = `${bookId}Fnref${Date.now()}${identifier}`;
          
          // Process the content HTML (may contain links), remove the [^1]: part
          const processedContent = p.innerHTML.replace(/^\[\^?\d+\]\s*:\s*/, '');
          
          footnotes.push({
            footnoteId: uniqueId,
            content: processedContent,
            originalIdentifier: identifier,
            refId: uniqueRefId,
            type: 'markdown-html'
          });
          
          footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
          
          // Remove this paragraph from the DOM so it doesn't appear in main content
          p.remove();
          console.log(`📝 Mapped markdown footnote ${identifier} to ${uniqueId}`);
        }
      }
    });
    
    // If we found references but no definitions, create placeholders
    footnoteRefs.forEach(identifier => {
      if (!footnoteMappings.has(identifier)) {
        const uniqueId = `${bookId}Fn${Date.now()}${identifier}`;
        const uniqueRefId = `${bookId}Fnref${Date.now()}${identifier}`;
        
        footnotes.push({
          footnoteId: uniqueId,
          content: `Footnote ${identifier} (definition not found)`,
          originalIdentifier: identifier,
          refId: uniqueRefId,
          type: 'markdown-placeholder'
        });
        
        footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
        console.log(`📝 Created placeholder for markdown footnote ${identifier}`);
      }
    });
  }

  // --- NEW HEURISTIC-BASED PARAGRAPH STRATEGY ---

  // 1. Find all reference callers (the <sup> tags) to see what we need to find.
  const supElements = tempDiv.querySelectorAll('sup');
  const refIdentifiers = new Set();
  supElements.forEach(sup => {
    const identifier = sup.textContent.trim() || sup.getAttribute('fn-count-id');
    if (identifier && /^\d+$/.test(identifier)) {
      refIdentifiers.add(identifier);
    }
  });

  // 2. Find all potential footnote definitions from <p> tags.
  const potentialParagraphDefs = new Map();
  
  if (formatType === 'taylor-francis') {
    // For T&F, look for paragraphs after "Notes" or "Footnotes" headings
    console.log('📝 T&F: Looking for footnotes after Notes/Footnotes headings');
    
    const headings = tempDiv.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headings.forEach(heading => {
      const headingText = heading.textContent.trim().toLowerCase();
      if (headingText.includes('notes') || headingText.includes('footnotes')) {
        console.log(`📝 T&F: Found footnotes section heading: "${heading.textContent.trim()}"`);
        
        // Find all paragraphs after this heading (until next heading or end)
        let nextElement = heading.nextElementSibling;
        while (nextElement) {
          // Stop if we hit another heading
          if (nextElement.tagName && /^H[1-6]$/.test(nextElement.tagName)) {
            break;
          }
          
          if (nextElement.tagName === 'P') {
            const pText = nextElement.textContent.trim();
            // Look for paragraphs starting with numbers (1, 2, 3, etc.)
            const match = pText.match(/^(\d+)[\.\)\s]/);
            if (match && pText.length > match[0].length) {
              potentialParagraphDefs.set(match[1], nextElement);
              console.log(`📝 T&F: Found footnote ${match[1]} after Notes heading: "${pText.substring(0, 50)}..."`);
            }
          } else if (nextElement.tagName === 'DIV') {
            // Also check paragraphs inside divs
            nextElement.querySelectorAll('p').forEach(p => {
              const pText = p.textContent.trim();
              const match = pText.match(/^(\d+)[\.\)\s]/);
              if (match && pText.length > match[0].length) {
                potentialParagraphDefs.set(match[1], p);
                console.log(`📝 T&F: Found footnote ${match[1]} in div after Notes: "${pText.substring(0, 50)}..."`);
              }
            });
          }
          
          nextElement = nextElement.nextElementSibling;
        }
      }
    });
  } else {
    // For other formats, use the original stricter pattern
    tempDiv.querySelectorAll('p').forEach(p => {
      const pText = p.textContent.trim();
      const match = pText.match(/^(\d+)[\.\)]/); // Match "1." or "1)" at the start
      if (match && pText.length > match[0].length) {
        potentialParagraphDefs.set(match[1], p);
      }
    });
  }

  // 3. Sanity Check: Only proceed if every reference has a potential definition.
  let allParaRefsHaveDefs = refIdentifiers.size > 0;
  for (const refId of refIdentifiers) {
    if (!potentialParagraphDefs.has(refId)) {
      allParaRefsHaveDefs = false;
      break;
    }
  }

  if (allParaRefsHaveDefs) {
    // The check passed. Assume these paragraphs are the footnotes.
    for (const identifier of refIdentifiers) {
      const pElement = potentialParagraphDefs.get(identifier);
      if (!pElement) continue; // Should not happen due to check above, but for safety.

      // Extract content, removing the "1. " prefix.
      const content = pElement.innerHTML.trim().replace(/^\s*\d+[\.\)]\s*/, '');
      
      const uniqueId = `${bookId}Fn${Date.now()}${identifier}`;
      const uniqueRefId = `${bookId}Fnref${Date.now()}${identifier}`;

      footnotes.push({
        footnoteId: uniqueId,
        content: content,
        originalIdentifier: identifier,
        refId: uniqueRefId,
        type: 'html-paragraph-heuristic'
      });
      footnoteMappings.set(identifier, { uniqueId, uniqueRefId });

      // Remove the element so it doesn't appear in the main body.
      pElement.remove();
    }
    // If we succeeded with this robust method, return straight away.
    return { footnotes, footnoteMappings };
  }

  // --- FALLBACK to original logic if the new heuristic fails ---

  // Fallback 1: Handle existing <sup> tags with direct links
  supElements.forEach(sup => {
    const identifier = sup.textContent.trim();
    if (/^\d+$/.test(identifier) && !footnoteMappings.has(identifier)) {
      const link = sup.querySelector('a');
      let content = '';
      if (link && link.href && link.href.includes('#')) {
        const targetId = link.href.split('#')[1];
        const targetElement = tempDiv.querySelector(`#${targetId}`);
        if (targetElement) {
          const tempTarget = targetElement.cloneNode(true);
          const backLink = tempTarget.querySelector('a[href*="#fnref"]');
          if (backLink) backLink.remove();
          content = tempTarget.innerHTML.trim();
        }
      }
      
      if (content) {
        const uniqueId = `${bookId}Fn${Date.now()}${identifier}`;
        const uniqueRefId = `${bookId}Fnref${Date.now()}${identifier}`;
        footnotes.push({ footnoteId: uniqueId, content, originalIdentifier: identifier, refId: uniqueRefId, type: 'html-sup-link' });
        footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
      }
    }
  });

  // Fallback 2: Look for traditional HTML footnote structure (ol/ul with li elements)
  const footnoteItems = tempDiv.querySelectorAll('ol li, ul li');
  footnoteItems.forEach((li, index) => {
    const backLink = li.querySelector('a[class*="footnote-back"], a[href*="#fnref"]');
    if (backLink) {
      const href = backLink.getAttribute('href') || '';
      const idMatch = href.match(/#fnref(\d+)/);
      const identifier = idMatch ? idMatch[1] : String(index + 1);
      
      if (!footnoteMappings.has(identifier)) {
        const uniqueId = `${bookId}Fn${Date.now()}${identifier}`;
        const uniqueRefId = `${bookId}Fnref${Date.now()}${identifier}`;
        const tempLi = li.cloneNode(true);
        const tempBackLink = tempLi.querySelector('a[class*="footnote-back"], a[href*="#fnref"]');
        if (tempBackLink) tempBackLink.remove();
        const content = tempLi.innerHTML.trim();
        
        footnotes.push({ footnoteId: uniqueId, content, originalIdentifier: identifier, refId: uniqueRefId, type: 'html-traditional' });
        footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
      }
    }
  });

  // Final Fallback: Create placeholders for any remaining sups that have no content
  supElements.forEach(sup => {
      const identifier = sup.textContent.trim();
      if (/^\d+$/.test(identifier) && !footnoteMappings.has(identifier)) {
          const uniqueId = `${bookId}Fn${Date.now()}${identifier}`;
          const uniqueRefId = `${bookId}Fnref${Date.now()}${identifier}`;
          const supParent = sup.parentElement;
          let content = `Footnote ${identifier}`;
          if (supParent) {
              const contextText = supParent.textContent.substring(0, 100);
              content = `Footnote ${identifier} (referenced in: "${contextText}...")`;
          }
          footnotes.push({ footnoteId: uniqueId, content, originalIdentifier: identifier, refId: uniqueRefId, type: 'placeholder' });
          footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
      }
  });

  return { footnotes, footnoteMappings };
}

/**
 * Extract footnotes from pasted content (based on process_document.py logic)
 */
export function extractFootnotes(htmlContent, bookId, isHTMLContent = false, formatType = 'general') {
  // Route to HTML-specific extraction if this is HTML content
  if (isHTMLContent) {
    return extractFootnotesFromHTML(htmlContent, bookId, formatType);
  }
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;
  
  const footnotes = [];
  const footnoteMappings = new Map(); // original_id -> unique_id mapping
  
  // 1. Handle traditional footnotes (li elements with footnote-back class)
  const footnoteItems = tempDiv.querySelectorAll('li');
  footnoteItems.forEach(li => {
    const backLink = li.querySelector('a[class*="footnote-back"]');
    if (backLink) {
      const href = backLink.getAttribute('href') || '';
      const idMatch = href.match(/#fnref(\d+)/);
      if (idMatch) {
        const identifier = idMatch[1];
        const uniqueId = `${bookId}Fn${Date.now()}${identifier}`;
        const uniqueRefId = `${bookId}Fnref${Date.now()}${identifier}`;
        
        // Extract content (remove back-link)
        const tempLi = li.cloneNode(true);
        const tempBackLink = tempLi.querySelector('a[class*="footnote-back"]');
        if (tempBackLink) tempBackLink.remove();
        const content = tempLi.innerHTML.trim();
        
        footnotes.push({
          footnoteId: uniqueId,
          content: content,
          originalIdentifier: identifier,
          refId: uniqueRefId,
          type: 'traditional'
        });
        
        footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
      }
    }
  });
  
  // 2. Handle markdown footnotes that weren't processed by marked()
  // First, find all [^1] and [1] references in text to know what footnotes we need  
  const allText = tempDiv.textContent;
  const footnoteRefs = new Set();
  const refPattern = /\[\^?(\d+)\]/g;
  let match;
  while ((match = refPattern.exec(allText)) !== null) {
    footnoteRefs.add(match[1]);
  }
  
  console.log(`📝 Found footnote references: [${Array.from(footnoteRefs).join(', ')}]`);
  
  // Now look for footnote definitions [^1]: content in paragraphs
  const allParagraphs = tempDiv.querySelectorAll('p');
  allParagraphs.forEach(p => {
    const text = p.textContent.trim();
    
    // Match patterns like [^1]: content or [1]: content at the start of paragraphs
    const markdownFootnoteMatch = text.match(/^\[\^?(\d+)\]\s*:\s*(.+)$/s);
    
    if (markdownFootnoteMatch) {
      const identifier = markdownFootnoteMatch[1];
      const content = markdownFootnoteMatch[2].trim();
      
      console.log(`📝 FOUND footnote definition: [^${identifier}]: ${content.substring(0, 50)}...`);
      
      if (identifier && content) {
        const uniqueId = `${bookId}Fn${Date.now()}${identifier}`;
        const uniqueRefId = `${bookId}Fnref${Date.now()}${identifier}`;
        
        // Process the content HTML (may contain links), remove the [^1]: part
        const processedContent = p.innerHTML.replace(/^\[\^?\d+\]\s*:\s*/, '');
        
        footnotes.push({
          footnoteId: uniqueId,
          content: processedContent,
          originalIdentifier: identifier,
          refId: uniqueRefId,
          type: 'markdown-html'
        });
        
        footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
        
        // Remove this paragraph from the DOM so it doesn't appear in main content
        p.remove();
        console.log(`📝 Mapped footnote ${identifier} to ${uniqueId}`);
      }
    }
  });
  
  // If we found references but no definitions, create placeholders
  footnoteRefs.forEach(identifier => {
    if (!footnoteMappings.has(identifier)) {
      const uniqueId = `${bookId}Fn${Date.now()}${identifier}`;
      const uniqueRefId = `${bookId}Fnref${Date.now()}${identifier}`;
      
      footnotes.push({
        footnoteId: uniqueId,
        content: `Footnote ${identifier} (definition not found)`,
        originalIdentifier: identifier,
        refId: uniqueRefId,
        type: 'markdown-placeholder'
      });
      
      footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
      console.log(`📝 Created placeholder for footnote ${identifier}`);
    }
  });
  
  // Fallback: Handle markdown-style footnotes in plain text (original logic)
  const footnotePattern = /^\s*(\[\^?(\d+)\]|\^(\d+))\s*[:.]\s*(.*?)(?=^\s*(\[\^?\d+\]|\^\d+)|$)/gms;
  let fallbackMatch;
  
  while ((fallbackMatch = footnotePattern.exec(allText)) !== null) {
    const identifier = fallbackMatch[2] || fallbackMatch[3]; // Extract digit from either group
    const content = fallbackMatch[4].trim();
    
    if (identifier && content && !footnoteMappings.has(identifier)) {
      const uniqueId = `${bookId}Fn${Date.now()}${identifier}`;
      const uniqueRefId = `${bookId}Fnref${Date.now()}${identifier}`;
      
      footnotes.push({
        footnoteId: uniqueId,
        content: content,
        originalIdentifier: identifier,
        refId: uniqueRefId,
        type: 'markdown'
      });
      
      footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
    }
  }
  
  // 3. Handle plain text footnotes with separate "Footnotes" section
  const plainTextFootnotes = extractPlainTextFootnotes(allText, bookId);
  footnotes.push(...plainTextFootnotes.footnotes);
  plainTextFootnotes.footnoteMappings.forEach((value, key) => {
    footnoteMappings.set(key, value);
  });
  
  return { footnotes, footnoteMappings };
}

/**
 * Extract footnotes from plain text content with a "Footnotes" section
 */
function extractPlainTextFootnotes(text, bookId) {
  const footnotes = [];
  const footnoteMappings = new Map();
  
  // Look for a "Footnotes" section
  const footnotesSectionMatch = text.match(/\n\s*Footnotes\s*\n([\s\S]*?)(?=\n\s*(?:References|Bibliography|Acknowledgments|$))/i);
  
  if (!footnotesSectionMatch) return { footnotes, footnoteMappings };
  
  const footnotesSection = footnotesSectionMatch[1];
  
  // Extract numbered footnote definitions from the footnotes section
  // Pattern: number at start of line followed by content
  const footnoteDefPattern = /^\s*(\d+)\s*\n((?:(?!\n\s*\d+\s*\n)[\s\S])*?)(?=\n\s*\d+\s*\n|$)/gm;
  let match;
  
  while ((match = footnoteDefPattern.exec(footnotesSection)) !== null) {
    const identifier = match[1];
    const content = match[2].trim();
    
    if (identifier && content) {
      const uniqueId = `${bookId}Fn${Date.now()}${identifier}`;
      const uniqueRefId = `${bookId}Fnref${Date.now()}${identifier}`;
      
      footnotes.push({
        footnoteId: uniqueId,
        content: content,
        originalIdentifier: identifier,
        refId: uniqueRefId,
        type: 'plaintext'
      });
      
      footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
    }
  }
  
  return { footnotes, footnoteMappings };
}

// ========================================================================
// REFERENCE EXTRACTION SYSTEM
// ========================================================================

/**
 * Check if a URL is a real link (not javascript or invalid)
 */
function isRealLink(href) {
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
 * Extract references from HTML content - specifically for HTML pastes
 */
function extractReferencesFromHTML(htmlContent, bookId, formatType = 'general') {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;
  
  const references = [];
  const referenceMappings = new Map();
  
  console.log(`📚 Extracting references using ${formatType} format strategy`);
  
  // Taylor & Francis specific extraction
  if (formatType === 'taylor-francis') {
    // Look for bibliography items that were processed (they should be removed from main content by now)
    // But check the original htmlContent for any remaining <li id="CIT..."> items
    const originalDiv = document.createElement('div');
    originalDiv.innerHTML = htmlContent;
    
    // Look for bibliography items with CIT IDs first
    const bibliographyItems = originalDiv.querySelectorAll('li[id^="CIT"]');
    bibliographyItems.forEach(item => {
      const citationId = item.id; // e.g., "CIT0061"
      const fullText = item.textContent.trim();
      
      // Extract author and year from full citation  
      const authorYearMatch = fullText.match(/^([^.]+?)[\. ]*\(?([12]\d{3}[a-z]?)\)?\.?\s/);
      if (authorYearMatch) {
        const author = authorYearMatch[1].trim();
        const year = authorYearMatch[2];
        
        const refKeys = generateRefKeys(`${author} ${year}`, '', formatType);
        // Also add citation ID-based keys for linking
        refKeys.push(citationId.toLowerCase() + year);
        refKeys.push(citationId.toLowerCase().replace('cit', '') + year);
        
        if (refKeys.length > 0) {
          const referenceId = refKeys[0];
          
          references.push({
            referenceId: referenceId,
            content: fullText,
            type: 'taylor-francis-cit',
            refKeys: refKeys
          });
          
          refKeys.forEach(key => {
            referenceMappings.set(key, referenceId);
          });
          
          console.log(`📚 T&F: Generated key "${referenceId}" from CIT item`);
        }
      }
    });
    
    // Also look for regular list items in bibliography sections (no CIT IDs)
    const bibliographyLists = originalDiv.querySelectorAll('ul li, ol li');
    bibliographyLists.forEach((item, index) => {
      // Skip if it already has a CIT ID (already processed above)
      if (item.id && item.id.startsWith('CIT')) return;
      
      const fullText = item.textContent.trim();
      if (!fullText) return;
      
      // Extract author and year from full citation  
      const authorYearMatch = fullText.match(/^([^.]+?)[\. ]*\(?([12]\d{3}[a-z]?)\)?\.?\s/);
      if (authorYearMatch) {
        const author = authorYearMatch[1].trim();
        const year = authorYearMatch[2];
        
        const refKeys = generateRefKeys(`${author} ${year}`, '', formatType);
        
        if (refKeys.length > 0) {
          const referenceId = refKeys[0];
          
          references.push({
            referenceId: referenceId,
            content: fullText,
            type: 'taylor-francis-list',
            refKeys: refKeys
          });
          
          refKeys.forEach(key => {
            referenceMappings.set(key, referenceId);
          });
          
          console.log(`📚 T&F: Generated key "${referenceId}" from list item ${index + 1}`);
        }
      }
    });
    
    // Also look for citation patterns in the processed text (after conversion)
    const citationPattern = /\(([^)]*?\d{4}[^)]*?)\)/g;
    let match;
    const textContent = tempDiv.textContent;
    
    while ((match = citationPattern.exec(textContent)) !== null) {
      const citationContent = match[1];
      const refKeys = generateRefKeys(citationContent, '', formatType);
      
      refKeys.forEach(key => {
        if (!referenceMappings.has(key)) {
          console.log(`📚 T&F: Found in-text citation pattern: ${citationContent}`);
        }
      });
    }
  }
  
  // 1. Look for references in <a> tags with real links
  const linkElements = tempDiv.querySelectorAll('a[href]');
  linkElements.forEach(link => {
    const href = link.getAttribute('href');
    if (isRealLink(href)) {
      const text = link.textContent.trim();
      
      // Check if this looks like a reference (contains year)
      if (/\d{4}/.test(text)) {
        const refKeys = generateRefKeys(text, '', formatType);
        if (refKeys.length > 0) {
          const referenceId = refKeys[0];
          
          references.push({
            referenceId: referenceId,
            content: link.outerHTML,
            originalText: text,
            type: 'html-link'
          });
          
          refKeys.forEach(key => {
            referenceMappings.set(key, referenceId);
          });
        }
      }
    }
  });
  
  // 2. Look for citation patterns in <a> tags (Author, Year) even if href is not real
  const allLinks = tempDiv.querySelectorAll('a');
  allLinks.forEach(link => {
    const text = link.textContent.trim();
    
    // Look for citation patterns like (Author, 2024) or (2024)
    const citationMatch = text.match(/^\s*\(([^)]*?\d{4}[^)]*?)\)\s*$/);
    if (citationMatch) {
      const citationContent = citationMatch[1];
      const refKeys = generateRefKeys(citationContent, '', formatType);
      if (refKeys.length > 0) {
        const referenceId = refKeys[0];
        
        references.push({
          referenceId: referenceId,
          content: `<span class="citation">${text}</span>`, // Convert to span since link might be fake
          originalText: citationContent,
          type: 'html-citation'
        });
        
        refKeys.forEach(key => {
          referenceMappings.set(key, referenceId);
        });
      }
    }
  });
  
  // 3. Fallback: Look for reference-like paragraphs with improved logic
  const allElements = Array.from(tempDiv.children);
  let referenceSectionStartIndex = -1;

  const refHeadings = /^(references|bibliography)$/i;
  for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      if (/^H[1-6]$/.test(el.tagName) && refHeadings.test(el.textContent.trim())) {
          referenceSectionStartIndex = i;
          break;
      }
  }

  let elementsToScan = [];
  if (referenceSectionStartIndex !== -1) {
      elementsToScan = allElements.slice(referenceSectionStartIndex + 1).filter(el => el.tagName === 'P');
  } else {
      elementsToScan = Array.from(tempDiv.querySelectorAll('p')).reverse();
  }

  const inTextCitePattern = /\(([^)]*?\d{4}[^)]*?)\)/;

  elementsToScan.forEach(p => {
    const text = p.textContent.trim();
    if (!text) return;

    // Stricter check: A reference list item should not contain an in-text citation.
    const citeMatch = text.match(inTextCitePattern);
    if (citeMatch) {
        const content = citeMatch[1];
        // Allow if it's just the year, e.g., Author. (2017). Title.
        // Reject if it's more complex, e.g., (see Smith, 2019) or (2017: 143)
        if (content.includes(',') || content.includes(':') || /[a-zA-Z]{2,}/.test(content)) {
            return; // This is a body paragraph, not a reference item.
        }
    }

    // Original check for reference-like structure (year appears early)
    const yearMatch = text.match(/(\d{4}[a-z]?)/);
    if (!yearMatch || yearMatch.index > 150) {
        return;
    }

    const refKeys = generateRefKeys(text, '', formatType);
    if (refKeys.length > 0) {
      const referenceId = refKeys[0];
      
      if (!referenceMappings.has(referenceId)) {
        references.push({
          referenceId: referenceId,
          content: p.outerHTML,
          originalText: text,
          type: 'html-paragraph'
        });
        
        refKeys.forEach(key => {
          referenceMappings.set(key, referenceId);
        });
      }
    }
  });
  
  return { references, referenceMappings };
}

/**
 * Extract references/bibliography from pasted content
 */
export function extractReferences(htmlContent, bookId, isHTMLContent = false, formatType = 'general') {
  // Route to HTML-specific extraction if this is HTML content
  if (isHTMLContent) {
    return extractReferencesFromHTML(htmlContent, bookId, formatType);
  }
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;
  
  const references = [];
  const referenceMappings = new Map(); // citation_key -> reference_id
  
  const allElements = Array.from(tempDiv.children);
  let referenceSectionStartIndex = -1;
  
  // Find a "References" or "Bibliography" heading
  const refHeadings = /^(references|bibliography)$/i;
  for (let i = 0; i < allElements.length; i++) {
      const el = allElements[i];
      if (/^H[1-6]$/.test(el.tagName) && refHeadings.test(el.textContent.trim())) {
          referenceSectionStartIndex = i;
          break;
      }
  }

  let elementsToScan = [];
  if (referenceSectionStartIndex !== -1) {
      // We found a heading, only scan elements after it
      elementsToScan = allElements.slice(referenceSectionStartIndex + 1).filter(el => el.tagName === 'P');
  } else {
      // No heading, fall back to scanning all paragraphs, but reversed (bottom-up)
      elementsToScan = Array.from(tempDiv.querySelectorAll('p')).reverse();
  }

  const inTextCitePattern = /\(([^)]*?\d{4}[^)]*?)\)/;
  
  elementsToScan.forEach(p => {
    const text = p.textContent.trim();
    if (!text) return;

    // Stricter check: A reference list item should not contain an in-text citation.
    const citeMatch = text.match(inTextCitePattern);
    if (citeMatch) {
        const content = citeMatch[1];
        // Allow if it's just the year, e.g., Author. (2017). Title.
        // Reject if it's more complex, e.g., (see Smith, 2019) or (2017: 143)
        if (content.includes(',') || content.includes(':') || /[a-zA-Z]{2,}/.test(content)) {
            return; // This is a body paragraph, not a reference item.
        }
    }

    // Original check for reference-like structure (year appears early)
    const yearMatch = text.match(/(\d{4}[a-z]?)/);
    if (!yearMatch || yearMatch.index > 150) {
        return;
    }

    const refKeys = generateRefKeys(text, '', formatType);
    if (refKeys.length > 0) {
      const referenceId = refKeys[0]; // Use first key as primary ID
      
      if (referenceMappings.has(referenceId)) return;

      references.push({
        referenceId: referenceId,
        content: p.outerHTML,
        originalText: text
      });
      
      refKeys.forEach(key => {
        referenceMappings.set(key, referenceId);
      });
    }
  });
  
  return { references, referenceMappings };
}

/**
 * Generate reference keys (adapted from Python version)
 */
function generateRefKeys(text, contextText = '', formatType = 'general') {
  // Remove year-only citations in brackets [2024]
  const processedText = text.replace(/\[\d{4}\]\s*/g, '');
  
  // Find year
  const yearMatch = processedText.match(/(\d{4}[a-z]?)/);
  if (!yearMatch) return [];
  
  const year = yearMatch[1];
  const authorsText = text.split(year)[0];
  
  const keys = [];
  const addKey = (key) => { if (key && !keys.includes(key)) keys.push(key); };

  const hasAuthor = /[a-zA-Z]/.test(authorsText);
  let authorSource = hasAuthor ? authorsText : contextText;
  
  // Taylor & Francis-specific handling: extract from citation IDs
  if (formatType === 'taylor-francis') {
    // For T&F, we often have citation patterns like "CIT0061" and years
    const tfCitationMatch = text.match(/CIT(\d+)/);
    if (tfCitationMatch && year) {
      const citationId = tfCitationMatch[1];
      addKey('cit' + citationId + year);
      addKey('citation' + citationId + year);
      console.log(`📚 T&F: Generated keys for citation ID ${citationId} with year ${year}`);
    }
    
    // Also try standard author extraction for T&F bibliography entries
    if (hasAuthor) {
      const tfAuthorMatch = authorsText.match(/([A-Z][a-zA-Z']+)/);
      if (tfAuthorMatch) {
        const surname = tfAuthorMatch[1];
        addKey(surname.toLowerCase() + year);
        console.log(`📚 T&F: Generated key "${surname.toLowerCase() + year}" from author`);
      }
    }
  }
  
  // OUP-specific handling: bibliography format is "Surname Firstname"
  if (formatType === 'oup' && hasAuthor) {
    // For OUP bibliography entries, extract surname first
    const oupMatch = authorsText.match(/^([A-Z][a-zA-Z']+)\s+([A-Z][a-zA-Z']+)/);
    if (oupMatch) {
      const [, surname, firstname] = oupMatch;
      // Create keys using just the surname (matches in-text citations)
      addKey(surname.toLowerCase() + year);
      console.log(`📚 OUP: Generated key "${surname.toLowerCase() + year}" from "${surname} ${firstname}"`);
      
      // Also add a key with both names for completeness
      addKey(surname.toLowerCase() + firstname.toLowerCase() + year);
      
      // Return early for OUP since we've handled it specially
      return keys;
    }
  }
  
  if (authorSource) {
    let sourceText = authorSource;
    
    // If no author in original text, use context to find it
    if (!hasAuthor && contextText) {
      const words = contextText.trim().split(/\s+/);
      const nameParts = [];
      for (let i = words.length - 1; i >= 0; i--) {
        const word = words[i].replace(/,$/, ''); // Clean trailing comma
        // A word is part of a name if it's capitalized or a common particle.
        if (/^[A-Z]/.test(word) || /^(van|der|de|la|von)$/i.test(word)) {
          nameParts.unshift(word);
        } else {
          // We hit a non-name word, so stop.
          break;
        }
        // Stop after a reasonable number of words to avoid grabbing whole sentences.
        if (nameParts.length >= 4) break;
      }
      
      if (nameParts.length > 0) {
        sourceText = nameParts.join(' ');
      } else {
        // Fallback to original logic if new logic finds nothing.
        const candidates = sourceText.match(/\b[A-Z][a-zA-Z']+\b/g);
        if (candidates) sourceText = candidates[candidates.length - 1];
      }
    }
    
    // Handle acronyms first as they are specific
    const acronyms = sourceText.match(/\b[A-Z]{2,}\b/g) || [];
    acronyms.forEach(acronym => {
        addKey(acronym.toLowerCase() + year);
    });

    // Then handle regular names
    const surnames = (sourceText.match(/\b[A-Z][a-zA-Z']+\b/g) || [])
      .filter(s => !['And', 'The', 'For', 'In', 'An', 'On', 'As', 'Ed', 'Of', 'See', 'Also'].includes(s))
      .filter(s => !acronyms.includes(s)) // Don't re-process acronyms as surnames
      .map(s => s.toLowerCase().replace("'s", ""));

    if (surnames.length > 0) {
      // Key 1: Sorted-concatenated (most consistent)
      const sortedSurnames = [...surnames].sort();
      addKey(sortedSurnames.join('') + year);

      // Key 2: Concatenated as-is (for orgs like Black Panther)
      if (surnames.length > 1 && !sourceText.includes(',')) {
        addKey(surnames.join('') + year);
      }

      // Key 3: Primary surname
      if (sourceText.includes(',')) {
        addKey(surnames[0] + year); // "Last, First"
      } else if (surnames.length > 0) {
        addKey(surnames[surnames.length - 1] + year); // "First Last"
      }
    }

    // NEW: Always add an initials-based key for linking acronyms
    const initials = sourceText.match(/\b[A-Z]/g)?.join('');
    if (initials && initials.length >= 2) {
        addKey(initials.toLowerCase() + year);
    }
  }
  
  // Special cases
  if (text.includes('United Nations General Assembly')) {
    addKey('un' + year);
  }
  
  return keys;
}

// ========================================================================
// HTML PREPROCESSING SYSTEM
// ========================================================================

/**
 * Preprocess HTML content to clean it for better extraction
 * - Strip JavaScript links and convert to plain text
 * - Preserve real links (http://, https://, #actualId)
 * - Keep <sup> tags and heading tags
 * - Convert everything else to clean text for pattern matching
 */
function preprocessHTMLContent(htmlContent) {
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
      
      // Ensure there's a proper structure for footnote linking
      if (!sup.querySelector('a')) {
        const link = document.createElement('a');
        link.href = `#fn${text}`;
        link.className = 'footnote-ref';
        link.textContent = text;
        sup.textContent = '';
        sup.appendChild(link);
      }
    }
  });
  
  return tempDiv.innerHTML;
}

// ========================================================================
// CONTENT PROCESSING SYSTEM
// ========================================================================

/**
 * Process and link in-text citations in pasted content
 */
export function processInTextCitations(htmlContent, referenceMappings, allReferences = [], formatType = 'general') {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;
  
  // Taylor & Francis specific processing
  if (formatType === 'taylor-francis') {
    console.log(`📚 T&F: Processing in-text citations with ${referenceMappings.size} reference mappings`);
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
        
        const keys = generateRefKeys(processedCite, text.substring(0, match.index), formatType);
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

/**
 * Process and link footnote references in pasted content
 */
export function processFootnoteReferences(htmlContent, footnoteMappings) {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;
  
  // Handle existing <sup> elements
  const supElements = tempDiv.querySelectorAll('sup');
  supElements.forEach(sup => {
    const identifier = sup.textContent.trim();
    if (footnoteMappings.has(identifier)) {
      const mapping = footnoteMappings.get(identifier);
      sup.id = mapping.uniqueRefId;
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
        const supHTML = `<sup id="${mapping.uniqueRefId}" fn-count-id="${identifier}"><a href="#${mapping.uniqueId}" class="footnote-ref">${identifier}</a></sup>`;
        
        replacements.push({
          start: match.index,
          end: match.index + match[0].length,
          replacement: supHTML
        });
        
        console.log(`🔗 Linking footnote reference [${match[0]}] to ${mapping.uniqueId}`);
      } else {
        console.log(`⚠️ No mapping found for footnote reference [${match[0]}]`);
      }
    }
    
    // Handle plain text footnote numbers AFTER punctuation
    // Pattern: punctuation followed by number (at word boundary or end of sentence)
    const plainFootnotePattern = /([.!?;,:])\s*(\d+)(?=\s|$|[.!?])/g;
    
    while ((match = plainFootnotePattern.exec(text)) !== null) {
      const identifier = match[2];
      const punctuation = match[1];
      
      if (footnoteMappings.has(identifier)) {
        const mapping = footnoteMappings.get(identifier);
        const supHTML = `${punctuation}<sup id="${mapping.uniqueRefId}" fn-count-id="${identifier}"><a href="#${mapping.uniqueId}" class="footnote-ref">${identifier}</a></sup>`;
        
        replacements.push({
          start: match.index,
          end: match.index + match[0].length,
          replacement: supHTML
        });
      }
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

// ========================================================================
// DATABASE STORAGE SYSTEM
// ========================================================================

/**
 * Save footnotes to IndexedDB
 */
export async function saveFootnotesToIndexedDB(footnotes, bookId) {
  if (footnotes.length === 0) return;
  
  try {
    const db = await openDatabase();
    const tx = db.transaction(['footnotes'], 'readwrite');
    const store = tx.objectStore('footnotes');
    
    for (const footnote of footnotes) {
      const key = [bookId, footnote.footnoteId];
      await store.put({
        book: bookId,
        footnoteId: footnote.footnoteId,
        content: footnote.content
      });
    }
    
    await tx.complete;
    console.log(`✅ Saved ${footnotes.length} footnotes to IndexedDB`);
  } catch (error) {
    console.error('❌ Error saving footnotes to IndexedDB:', error);
  }
}

/**
 * Save references to IndexedDB
 */
export async function saveReferencesToIndexedDB(references, bookId) {
  if (references.length === 0) return;
  
  try {
    const db = await openDatabase();
    const tx = db.transaction(['references'], 'readwrite');
    const store = tx.objectStore('references');
    
    for (const reference of references) {
      const key = [bookId, reference.referenceId];
      await store.put({
        book: bookId,
        referenceId: reference.referenceId,
        content: reference.content
      });
    }
    
    await tx.complete;
    console.log(`✅ Saved ${references.length} references to IndexedDB`);
  } catch (error) {
    console.error('❌ Error saving references to IndexedDB:', error);
  }
}

// ========================================================================
// MAIN PROCESSING FUNCTION
// ========================================================================

/**
 * Process pasted content for footnotes and references
 * Returns processed HTML with linked footnotes/citations
 */
export async function processContentForFootnotesAndReferences(htmlContent, bookId, isHTMLContent = false, formatType = 'general') {
  console.log('🔍 Processing pasted content for footnotes and references...');
  console.log('🔍 Content type:', isHTMLContent ? 'HTML' : 'Markdown/Plain text');
  console.log('🔍 Format type:', formatType);
  
  let contentToProcess = htmlContent;
  
  // If this is HTML content, preprocess it first
  if (isHTMLContent) {
    console.log('🔧 Preprocessing HTML content...');
    contentToProcess = preprocessHTMLContent(htmlContent);
    console.log('🔧 HTML preprocessing complete');
  }
  
  // Taylor & Francis specific: Clean up Citation patterns and footnotes BEFORE extracting references
  if (formatType === 'taylor-francis') {
    console.log('🧹 T&F: Cleaning Citation patterns and footnotes BEFORE reference extraction');
    const beforeCleanup = contentToProcess;
    console.log('🔍 T&F: Content before cleanup (first 200 chars):', beforeCleanup.substring(0, 200));
    
    // 1. Replace "Citation" followed by digits with just the digits
    contentToProcess = contentToProcess.replace(/Citation(\d+)/g, '$1');
    
    // 2. Clean up footnote links - remove the <a> wrapper and "Footnote" text, keep only the <sup>
    // First, let's see what footnotes we can find
    const footnoteMatches = contentToProcess.match(/<a[^>]*data-ref-type="fn"[^>]*>Footnote.*?<\/a>/g);
    console.log('🔍 T&F: Found footnote patterns:', footnoteMatches ? footnoteMatches.length : 0);
    if (footnoteMatches) {
      footnoteMatches.forEach((match, index) => {
        console.log(`🔍 T&F: Footnote ${index + 1}:`, match.substring(0, 100));
      });
    }
    
    // Handle the full T&F footnote structure with all attributes
    // Match <sup> tags that might be empty or have content
    contentToProcess = contentToProcess.replace(
      /<a[^>]*data-ref-type="fn"[^>]*>Footnote(<sup[^>]*>.*?<\/sup>)<\/a>/g, 
      '$1'
    );
    
    // Also handle any remaining "Footnote" text that might be standalone
    contentToProcess = contentToProcess.replace(/Footnote(<sup[^>]*>.*?<\/sup>)/g, '$1');
    
    // Debug: Check if footnotes were actually cleaned up
    const remainingFootnotes = contentToProcess.match(/<a[^>]*data-ref-type="fn"[^>]*>Footnote.*?<\/a>/g);
    console.log('🔍 T&F: Remaining footnote patterns after cleanup:', remainingFootnotes ? remainingFootnotes.length : 0);
    
    const cleanupChanged = beforeCleanup !== contentToProcess;
    console.log('🔍 T&F: Citation and footnote cleanup changed content:', cleanupChanged);
    console.log('🔍 T&F: Content after cleanup (first 200 chars):', contentToProcess.substring(0, 200));
    console.log('✅ T&F: Citation and footnote cleanup complete - now references can be properly extracted');
  }
  
  // Extract footnotes and references with the appropriate method
  const { footnotes, footnoteMappings } = extractFootnotes(contentToProcess, bookId, isHTMLContent, formatType);
  const { references, referenceMappings } = extractReferences(contentToProcess, bookId, isHTMLContent, formatType);
  
  console.log(`Found ${footnotes.length} footnotes and ${references.length} references`);
  if (footnotes.length > 0) {
    console.log('📝 Footnote types:', footnotes.map(f => f.type));
  }
  if (references.length > 0) {
    console.log('📚 Reference types:', references.map(r => r.type));
  }
  
  // Process the content to add links
  let processedContent = contentToProcess;
  
  if (referenceMappings.size > 0) {
    processedContent = processInTextCitations(processedContent, referenceMappings, references, formatType);
  }
  
  if (footnoteMappings.size > 0) {
    processedContent = processFootnoteReferences(processedContent, footnoteMappings);
  }
  
  // Save to IndexedDB
  await Promise.all([
    saveFootnotesToIndexedDB(footnotes, bookId),
    saveReferencesToIndexedDB(references, bookId)
  ]);
  
  // Direct sync to PostgreSQL (mass upsert)
  const syncPromises = [];
  
  if (footnotes.length > 0) {
    syncPromises.push(
      syncFootnotesToPostgreSQL(footnotes, bookId)
    );
  }
  
  if (references.length > 0) {
    syncPromises.push(
      syncReferencesToPostgreSQL(references, bookId)
    );
  }
  
  if (syncPromises.length > 0) {
    try {
      await Promise.all(syncPromises);
      console.log(`✅ Synced ${footnotes.length} footnotes and ${references.length} references to PostgreSQL`);
    } catch (error) {
      console.error('❌ Failed to sync footnotes/references to PostgreSQL:', error);
    }
  }
  
  return {
    processedContent,
    footnotes,
    references,
    footnoteMappings,
    referenceMappings
  };
}

// ========================================================================
// POSTGRESQL SYNC FUNCTIONS
// ========================================================================

/**
 * Sync footnotes directly to PostgreSQL
 */
async function syncFootnotesToPostgreSQL(footnotes, bookId) {
  if (!footnotes || footnotes.length === 0) return;
  
  try {
    const response = await fetch('/api/db/footnotes/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        book: bookId,
        data: footnotes.map(footnote => ({
          footnoteId: footnote.footnoteId,
          content: footnote.content
        }))
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const result = await response.json();
    console.log(`✅ PostgreSQL footnotes sync: ${result.message}`);
    return result;
    
  } catch (error) {
    console.error('❌ Failed to sync footnotes to PostgreSQL:', error);
    throw error;
  }
}

/**
 * Sync references directly to PostgreSQL  
 */
async function syncReferencesToPostgreSQL(references, bookId) {
  if (!references || references.length === 0) return;
  
  try {
    const response = await fetch('/api/db/references/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        book: bookId,
        data: references.map(reference => ({
          referenceId: reference.referenceId,
          content: reference.content
        }))
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const result = await response.json();
    console.log(`✅ PostgreSQL references sync: ${result.message}`);
    return result;
    
  } catch (error) {
    console.error('❌ Failed to sync references to PostgreSQL:', error);
    throw error;
  }
}
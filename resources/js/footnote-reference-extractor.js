// footnote-reference-extractor.js - Extract footnotes and references from pasted content
import { openDatabase } from './cache-indexedDB.js';

// ========================================================================
// FOOTNOTE EXTRACTION SYSTEM
// ========================================================================

/**
 * Extract footnotes from HTML content - specifically for HTML pastes
 */
function extractFootnotesFromHTML(htmlContent, bookId) {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;
  
  const footnotes = [];
  const footnoteMappings = new Map();
  
  // 1. Handle existing <sup> tags with footnote references
  const supElements = tempDiv.querySelectorAll('sup');
  supElements.forEach(sup => {
    const identifier = sup.textContent.trim();
    const link = sup.querySelector('a');
    
    if (/^\d+$/.test(identifier)) {
      const uniqueId = `${bookId}Fn${Date.now()}${identifier}`;
      const uniqueRefId = `${bookId}Fnref${Date.now()}${identifier}`;
      
      // Try multiple strategies to find footnote content
      let content = '';
      
      // Strategy 1: Follow the link if it exists
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
      
      // Strategy 2: Look for footnotes in common patterns if no linked content
      if (!content) {
        // Look for footnote content in various patterns
        const patterns = [
          // Pattern 1: Look for "1. footnote content" or "1) footnote content"
          new RegExp(`^\\s*${identifier}[\\.\\)]\\s*(.+)`, 'm'),
          // Pattern 2: Look in a footnotes section
          new RegExp(`\\n\\s*${identifier}[\\.\\)]?\\s*([^\\n]+)`, 'm'),
          // Pattern 3: Look for footnote in list items
          new RegExp(`<li[^>]*>\\s*${identifier}[\\.\\)]?\\s*([\\s\\S]*?)</li>`, 'i')
        ];
        
        const allText = tempDiv.textContent;
        const allHTML = tempDiv.innerHTML;
        
        for (const pattern of patterns) {
          const match = pattern.test(allText) ? allText.match(pattern) : allHTML.match(pattern);
          if (match && match[1]) {
            content = match[1].trim();
            break;
          }
        }
      }
      
      // Strategy 3: Look in document structure for footnotes section
      if (!content) {
        const footnotesSections = tempDiv.querySelectorAll('.footnotes, #footnotes, [class*="footnote"], [id*="footnote"]');
        for (const section of footnotesSections) {
          const sectionText = section.textContent;
          const match = sectionText.match(new RegExp(`${identifier}[\\.\\)]?\\s*([^\\n]+)`, 'm'));
          if (match) {
            content = match[1].trim();
            break;
          }
        }
      }
      
      // Strategy 4: Create a reasonable placeholder based on context
      if (!content) {
        // Look at surrounding text for context clues
        const supParent = sup.parentElement;
        if (supParent) {
          const contextText = supParent.textContent.substring(0, 100);
          content = `Footnote ${identifier} (referenced in: "${contextText}...")`;
        } else {
          content = `Footnote ${identifier}`;
        }
      }
      
      footnotes.push({
        footnoteId: uniqueId,
        content: content,
        originalIdentifier: identifier,
        refId: uniqueRefId,
        type: 'html-sup'
      });
      
      footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
    }
  });
  
  // 2. Look for traditional HTML footnote structure (ol/ul with li elements)
  const footnoteItems = tempDiv.querySelectorAll('ol li, ul li');
  footnoteItems.forEach((li, index) => {
    const backLink = li.querySelector('a[class*="footnote-back"], a[href*="#fnref"]');
    if (backLink) {
      const href = backLink.getAttribute('href') || '';
      const idMatch = href.match(/#fnref(\d+)/);
      const identifier = idMatch ? idMatch[1] : String(index + 1);
      
      // Skip if we already processed this footnote from sup tags
      if (footnoteMappings.has(identifier)) return;
      
      const uniqueId = `${bookId}Fn${Date.now()}${identifier}`;
      const uniqueRefId = `${bookId}Fnref${Date.now()}${identifier}`;
      
      // Extract content (remove back-link)
      const tempLi = li.cloneNode(true);
      const tempBackLink = tempLi.querySelector('a[class*="footnote-back"], a[href*="#fnref"]');
      if (tempBackLink) tempBackLink.remove();
      const content = tempLi.innerHTML.trim();
      
      footnotes.push({
        footnoteId: uniqueId,
        content: content,
        originalIdentifier: identifier,
        refId: uniqueRefId,
        type: 'html-traditional'
      });
      
      footnoteMappings.set(identifier, { uniqueId, uniqueRefId });
    }
  });
  
  return { footnotes, footnoteMappings };
}

/**
 * Extract footnotes from pasted content (based on process_document.py logic)
 */
export function extractFootnotes(htmlContent, bookId, isHTMLContent = false) {
  // Route to HTML-specific extraction if this is HTML content
  if (isHTMLContent) {
    return extractFootnotesFromHTML(htmlContent, bookId);
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
  
  // 2. Handle markdown-style footnotes [^1]: content
  const allText = tempDiv.textContent;
  const footnotePattern = /^\s*(\[\^?(\d+)\]|\^(\d+))\s*[:.]\s*(.*?)(?=^\s*(\[\^?\d+\]|\^\d+)|$)/gms;
  let match;
  
  while ((match = footnotePattern.exec(allText)) !== null) {
    const identifier = match[2] || match[3]; // Extract digit from either group
    const content = match[4].trim();
    
    if (identifier && content) {
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
function extractReferencesFromHTML(htmlContent, bookId) {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;
  
  const references = [];
  const referenceMappings = new Map();
  
  // 1. Look for references in <a> tags with real links
  const linkElements = tempDiv.querySelectorAll('a[href]');
  linkElements.forEach(link => {
    const href = link.getAttribute('href');
    if (isRealLink(href)) {
      const text = link.textContent.trim();
      
      // Check if this looks like a reference (contains year)
      if (/\d{4}/.test(text)) {
        const refKeys = generateRefKeys(text);
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
      const refKeys = generateRefKeys(citationContent);
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
  
  // 3. Fallback: Look for reference-like paragraphs (same as original logic)
  const paragraphs = tempDiv.querySelectorAll('p');
  paragraphs.forEach(p => {
    const text = p.textContent.trim();
    
    // Check if this looks like a reference (starts with capital, contains year)
    if (/^[A-Z]/.test(text) && /\d{4}/.test(text)) {
      const refKeys = generateRefKeys(text);
      if (refKeys.length > 0) {
        const referenceId = refKeys[0];
        
        // Skip if we already have this reference from links
        if (!referenceMappings.has(refKeys[0])) {
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
    }
  });
  
  return { references, referenceMappings };
}

/**
 * Extract references/bibliography from pasted content
 */
export function extractReferences(htmlContent, bookId, isHTMLContent = false) {
  // Route to HTML-specific extraction if this is HTML content
  if (isHTMLContent) {
    return extractReferencesFromHTML(htmlContent, bookId);
  }
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;
  
  const references = [];
  const referenceMappings = new Map(); // citation_key -> reference_id
  
  // Find paragraphs that look like references (contain 4-digit years)
  const paragraphs = tempDiv.querySelectorAll('p');
  paragraphs.forEach(p => {
    const text = p.textContent.trim();
    
    // Check if this looks like a reference (starts with capital, contains year)
    if (/^\s*[A-Z]/.test(text) && /\d{4}/.test(text)) {
      const refKeys = generateRefKeys(text);
      if (refKeys.length > 0) {
        const referenceId = refKeys[0]; // Use first key as primary ID
        
        references.push({
          referenceId: referenceId,
          content: p.outerHTML,
          originalText: text
        });
        
        // Map all generated keys to this reference
        refKeys.forEach(key => {
          referenceMappings.set(key, referenceId);
        });
      }
    }
  });
  
  return { references, referenceMappings };
}

/**
 * Generate reference keys (adapted from Python version)
 */
function generateRefKeys(text, contextText = '') {
  // Remove year-only citations in brackets [2024]
  const processedText = text.replace(/\[\d{4}\]\s*/g, '');
  
  // Find year
  const yearMatch = processedText.match(/(\d{4}[a-z]?)/);
  if (!yearMatch) return [];
  
  const year = yearMatch[1];
  const authorsText = text.split(year)[0];
  
  const keys = new Set();
  const hasAuthor = /[a-zA-Z]/.test(authorsText);
  const authorSource = hasAuthor ? authorsText : contextText;
  
  if (authorSource) {
    let sourceText = authorSource;
    
    // If no author in original text, use context
    if (!hasAuthor) {
      const candidates = sourceText.match(/\b[A-Z][a-zA-Z']+\b/g);
      if (candidates) sourceText = candidates[candidates.length - 1];
    }
    
    // Extract surnames
    const surnames = (sourceText.match(/\b[A-Z][a-zA-Z']+\b/g) || [])
      .filter(s => !['And', 'The', 'For', 'In', 'An', 'On', 'As', 'Ed', 'Of', 'See', 'Also'].includes(s))
      .map(s => s.toLowerCase().replace("'s", ""));
    
    if (surnames.length > 0) {
      keys.add(surnames[0] + year);
      const sortedSurnames = [...surnames].sort();
      keys.add(sortedSurnames.join('') + year);
    }
  }
  
  // Handle acronyms
  const acronyms = authorSource.match(/\b[A-Z]{2,}\b/g) || [];
  acronyms.forEach(acronym => {
    keys.add(acronym.toLowerCase() + year);
  });
  
  // Special cases
  if (text.includes('United Nations General Assembly')) {
    keys.add('un' + year);
  }
  
  return Array.from(keys);
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
      // Convert citation links to spans for text-based processing
      const span = document.createElement('span');
      span.className = 'citation-text';
      span.textContent = text;
      // Preserve original attributes as data attributes for potential later use
      if (link.hasAttribute('data-open')) {
        span.setAttribute('data-original-ref', link.getAttribute('data-open'));
      }
      link.replaceWith(span);
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
export function processInTextCitations(htmlContent, referenceMappings) {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = htmlContent;
  
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
        
        const keys = generateRefKeys(trimmed, text.substring(0, match.index));
        let linked = false;
        
        for (const key of keys) {
          if (referenceMappings.has(key)) {
            const yearMatch = trimmed.match(/(\d{4}[a-z]?)/);
            if (yearMatch) {
              const authorPart = trimmed.substring(0, yearMatch.index);
              const yearPart = yearMatch[1];
              const trailingPart = trimmed.substring(yearMatch.index + yearMatch[0].length);
              
              linkedParts.push(
                authorPart,
                `<a href="#${referenceMappings.get(key)}" class="in-text-citation">${yearPart}</a>`,
                trailingPart
              );
            } else {
              linkedParts.push(`<a href="#${referenceMappings.get(key)}" class="in-text-citation">${trimmed}</a>`);
            }
            linked = true;
            break;
          }
        }
        
        if (!linked) linkedParts.push(trimmed);
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
    
    // Handle markdown-style references [^1]
    const footnoteRefPattern = /\[\^?(\w+)\]/g;
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
export async function processContentForFootnotesAndReferences(htmlContent, bookId, isHTMLContent = false) {
  console.log('🔍 Processing pasted content for footnotes and references...');
  console.log('🔍 Content type:', isHTMLContent ? 'HTML' : 'Markdown/Plain text');
  
  let contentToProcess = htmlContent;
  
  // If this is HTML content, preprocess it first
  if (isHTMLContent) {
    console.log('🔧 Preprocessing HTML content...');
    contentToProcess = preprocessHTMLContent(htmlContent);
    console.log('🔧 HTML preprocessing complete');
  }
  
  // Extract footnotes and references with the appropriate method
  const { footnotes, footnoteMappings } = extractFootnotes(contentToProcess, bookId, isHTMLContent);
  const { references, referenceMappings } = extractReferences(contentToProcess, bookId, isHTMLContent);
  
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
    processedContent = processInTextCitations(processedContent, referenceMappings);
  }
  
  if (footnoteMappings.size > 0) {
    processedContent = processFootnoteReferences(processedContent, footnoteMappings);
  }
  
  // Save to IndexedDB
  await Promise.all([
    saveFootnotesToIndexedDB(footnotes, bookId),
    saveReferencesToIndexedDB(references, bookId)
  ]);
  
  return {
    processedContent,
    footnotes,
    references,
    footnoteMappings,
    referenceMappings
  };
}
/**
 * Note Listener - Unified handler for all contenteditable elements in hyperlit-container
 * Handles input, paste, and placeholder behavior for both annotations and footnotes
 */

import { saveHighlightAnnotation } from '../hyperlights/annotations.js';
import { saveFootnoteToIndexedDB } from '../footnotes/footnoteAnnotations.js';
import { sanitizeHtml } from '../utilities/sanitizeConfig.js';
import { parseHyperciteHref, attachUnderlineClickListeners } from '../hypercites/index.js';
import { extractQuotedText } from '../utilities/textExtraction.js';
import { updateCitationForExistingHypercite } from '../indexedDB/index.js';
import { book } from '../app.js';
import { broadcastToOpenTabs } from '../utilities/BroadcastListener.js';

// Track debounce timers by ID
const debounceTimers = new Map();

// Track if listeners are attached
let isAttached = false;

// Store handler references for cleanup
let inputHandler = null;
let pasteHandler = null;
let focusHandler = null;
let blurHandler = null;
let supEscapeHandler = null;

/**
 * SUP TAG ESCAPE: Prevent typing inside sup elements
 * Sup tags contain generated content (hypercite arrows) - never user-editable
 */
function handleSupEscape(e) {
  // Only handle text insertion events
  if (!e.inputType || !e.inputType.startsWith('insert')) return;

  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;

  // Use anchorNode which is more reliable for cursor position
  let node = selection.anchorNode;
  if (!node) return;

  // Get the element (if text node, get parent)
  let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!element) return;

  // Only handle if inside our contenteditable elements
  const isInAnnotation = element.closest('.annotation[data-highlight-id]');
  const isInFootnote = element.closest('.footnote-text[data-footnote-id]');
  if (!isInAnnotation && !isInFootnote) return;

  // Check if we're inside a <sup> tag
  const supElement = element.closest('sup');
  if (!supElement) return;

  // We're inside a sup - move cursor outside before the input happens
  e.preventDefault();
  e.stopPropagation();

  const textToInsert = e.data || '';

  // Insert text directly after the sup element
  supElement.insertAdjacentText('afterend', textToInsert);

  // Position cursor after the inserted text
  const nextNode = supElement.nextSibling;
  if (nextNode && nextNode.nodeType === Node.TEXT_NODE) {
    const newRange = document.createRange();
    newRange.setStart(nextNode, nextNode.length);
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);
  }
}

/**
 * Attach unified listeners to hyperlit-container
 * Uses event delegation - one set of listeners handles all editables
 */
export function attachNoteListeners() {
  const container = document.getElementById('hyperlit-container');
  if (!container || isAttached) return;

  inputHandler = handleInput;
  pasteHandler = handlePaste;
  focusHandler = updatePlaceholder;
  blurHandler = updatePlaceholder;

  // Input handler (debounced save)
  container.addEventListener('input', inputHandler);

  // Paste handler (prevent double-paste, handle hypercites)
  container.addEventListener('paste', pasteHandler);

  // Focus/blur for placeholder behavior (use capture to catch before bubble)
  container.addEventListener('focus', focusHandler, true);
  container.addEventListener('blur', blurHandler, true);

  // SUP TAG ESCAPE: Prevent typing inside sup elements (hypercite arrows)
  supEscapeHandler = handleSupEscape;
  container.addEventListener('beforeinput', supEscapeHandler, { capture: true });

  isAttached = true;
  console.log('Note listeners attached to hyperlit-container');
}

/**
 * Cleanup when container closes
 * Flushes any pending saves before detaching listeners
 */
export function detachNoteListeners() {
  const container = document.getElementById('hyperlit-container');
  if (!container || !isAttached) return;

  container.removeEventListener('input', inputHandler);
  container.removeEventListener('paste', pasteHandler);
  container.removeEventListener('focus', focusHandler, true);
  container.removeEventListener('blur', blurHandler, true);

  // Remove sup escape handler
  if (supEscapeHandler) {
    container.removeEventListener('beforeinput', supEscapeHandler, { capture: true });
    supEscapeHandler = null;
  }

  // Flush pending saves before clearing timers
  flushPendingSaves(container);

  // Clear all pending debounce timers (saves already flushed)
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  isAttached = false;
  console.log('Note listeners detached from hyperlit-container');
}

/**
 * Flush all pending debounced saves immediately
 * Called when exiting edit mode to ensure no content is lost
 */
function flushPendingSaves(container) {
  if (debounceTimers.size === 0) return;

  console.log(`Flushing ${debounceTimers.size} pending save(s)...`);

  for (const [id, timer] of debounceTimers.entries()) {
    // Cancel the pending timer
    clearTimeout(timer);

    // Determine if this is a highlight or footnote and save immediately
    const annotation = container.querySelector(`.annotation[data-highlight-id="${id}"]`);
    const footnote = container.querySelector(`.footnote-text[data-footnote-id="${id}"]`);

    if (annotation) {
      const content = annotation.innerHTML || '';
      saveContent('highlight', id, content);
    } else if (footnote) {
      const content = footnote.innerHTML || '';
      saveContent('footnote', id, content);
    }
  }
}

/**
 * Handle input events on contenteditable elements
 * Debounces saves to avoid excessive writes
 */
function handleInput(e) {
  const target = e.target;

  // Find the contenteditable parent (input target might be a child element)
  const annotation = target.closest('.annotation[data-highlight-id]');
  const footnote = target.closest('.footnote-text[data-footnote-id]');

  const highlightId = annotation?.dataset.highlightId;
  const footnoteId = footnote?.dataset.footnoteId;

  // Only handle our contenteditable elements
  if (!highlightId && !footnoteId) return;

  const id = highlightId || footnoteId;
  const type = highlightId ? 'highlight' : 'footnote';
  const editableElement = annotation || footnote;
  const content = editableElement.innerHTML || '';

  // Clear existing debounce timer for this ID
  if (debounceTimers.has(id)) {
    clearTimeout(debounceTimers.get(id));
  }

  // Debounced save (1 second delay)
  debounceTimers.set(id, setTimeout(() => {
    saveContent(type, id, content);
    debounceTimers.delete(id);
  }, 1000));

  // Update placeholder state immediately
  updatePlaceholderForTarget(editableElement);
}

/**
 * Handle paste events
 * Prevents double-paste bug and handles hypercite pasting
 */
async function handlePaste(e) {
  const target = e.target;

  // Find the contenteditable parent (paste target might be a child element)
  const annotation = target.closest('.annotation[data-highlight-id]');
  const footnote = target.closest('.footnote-text[data-footnote-id]');

  const highlightId = annotation?.dataset.highlightId;
  const footnoteId = footnote?.dataset.footnoteId;

  // Only handle our contenteditable elements
  if (!highlightId && !footnoteId) return;

  // CRITICAL: Prevent default immediately to avoid double-paste
  e.preventDefault();

  const clipboardHtml = e.clipboardData.getData('text/html');
  const plainText = e.clipboardData.getData('text/plain');

  // Check for hypercite paste
  const contentId = highlightId || footnoteId;
  const wasHypercite = await processHypercitePaste(clipboardHtml, contentId);

  if (!wasHypercite) {
    // Plain text paste
    document.execCommand('insertText', false, plainText);
  }

  // Save after paste - use the contenteditable element, not the event target
  const type = highlightId ? 'highlight' : 'footnote';
  const editableElement = annotation || footnote;

  // Cancel any pending debounce for this ID to avoid duplicate saves
  if (debounceTimers.has(contentId)) {
    clearTimeout(debounceTimers.get(contentId));
    debounceTimers.delete(contentId);
  }

  saveContent(type, contentId, editableElement.innerHTML);
}

/**
 * Handle focus/blur for placeholder behavior
 */
function updatePlaceholder(e) {
  const target = e.target;
  updatePlaceholderForTarget(target);
}

/**
 * Update placeholder class for a specific target
 */
function updatePlaceholderForTarget(target) {
  // Check if it's one of our contenteditable elements
  const isAnnotation = target.classList.contains('annotation');
  const isFootnote = target.classList.contains('footnote-text');

  if (!isAnnotation && !isFootnote) return;

  const isEmpty = !target.textContent.trim();

  if (isAnnotation) {
    target.classList.toggle('empty-annotation', isEmpty);
  } else if (isFootnote) {
    target.classList.toggle('empty-footnote', isEmpty);
  }
}

/**
 * Route save to appropriate handler based on type
 */
async function saveContent(type, id, content) {
  try {
    if (type === 'highlight') {
      await saveHighlightAnnotation(id, content);
      console.log(`Annotation saved for highlight: ${id}`);
    } else {
      await saveFootnoteToIndexedDB(id, content);
      console.log(`Content saved for footnote: ${id}`);
    }
  } catch (error) {
    console.error(`Error saving ${type} content:`, error);
  }
}

/**
 * Process pasted hypercite links
 * Extracted from annotationPaste.js for shared use
 */
async function processHypercitePaste(clipboardHtml, contentId) {
  if (!clipboardHtml) return false;

  const pasteWrapper = document.createElement('div');
  pasteWrapper.innerHTML = sanitizeHtml(clipboardHtml);

  const citeLink = pasteWrapper.querySelector(
    'a[id^="hypercite_"] > sup.open-icon, a[id^="hypercite_"] > span.open-icon'
  )?.parentElement;

  if (!(citeLink && (citeLink.innerText.trim() === '↗' ||
      (citeLink.closest('span, sup') &&
       (citeLink.closest('span')?.classList.contains('open-icon') ||
        citeLink.closest('sup')?.classList.contains('open-icon')))))) {
    return false;
  }

  console.log('Detected hypercite in paste');

  const originalHref = citeLink.getAttribute('href');
  const parsed = parseHyperciteHref(originalHref);
  if (!parsed) return false;

  const { booka, hyperciteIDa, citationIDa } = parsed;
  const hyperciteIDb = 'hypercite_' + Math.random().toString(36).substr(2, 8);
  const citationIDb = `/${book}/${contentId}#${hyperciteIDb}`;

  // Extract quoted text - first try from the DOM structure (most reliable)
  let quotedText = '';

  // Method 1: Look for text node before the link in the sanitized DOM
  let textNode = citeLink.previousSibling;
  while (textNode) {
    if (textNode.nodeType === Node.TEXT_NODE) {
      const text = textNode.textContent.trim();
      if (text) {
        quotedText = text;
        break;
      }
    } else if (textNode.nodeType === Node.ELEMENT_NODE) {
      const textContent = textNode.textContent.trim();
      if (textContent) {
        quotedText = textContent;
        break;
      }
    }
    textNode = textNode.previousSibling;
  }

  // Method 2: Try extractQuotedText utility
  if (!quotedText) {
    quotedText = extractQuotedText(pasteWrapper);
  }

  // Method 3: Last resort - regex on clipboard HTML, but be more specific
  // Look for pattern like 'text'<a to avoid matching meta tags
  if (!quotedText) {
    const quoteMatch = clipboardHtml.match(/'([^']+)'(?=\s*<a\s+href)/);
    if (quoteMatch) {
      quotedText = quoteMatch[1];
    }
  }

  // Clean up quotes from the extracted text
  quotedText = quotedText.replace(/^['"]|['"]$/g, '');

  const referenceHtml = `'${quotedText}'<a href="${originalHref}" id="${hyperciteIDb}"><sup class="open-icon">↗</sup></a>`;

  // Insert the hypercite HTML
  document.execCommand('insertHTML', false, referenceHtml);

  // Attach click listeners to the newly inserted hypercite link
  setTimeout(() => {
    attachUnderlineClickListeners();
  }, 100);

  // Update the original hypercite in the database
  try {
    const updateResult = await updateCitationForExistingHypercite(
      booka,
      hyperciteIDa,
      citationIDb
    );
    if (updateResult && updateResult.success) {
      console.log(`Successfully linked: ${citationIDa} cited in ${citationIDb}`);
      broadcastToOpenTabs(book, updateResult.startLine);
    }
  } catch (error) {
    console.error('Error during hypercite paste update:', error);
  }

  return true;
}

/**
 * Initialize placeholder state for all contenteditable elements
 * Call after content is loaded
 */
export function initializePlaceholders() {
  const container = document.getElementById('hyperlit-container');
  if (!container) return;

  // Check all annotations
  container.querySelectorAll('.annotation').forEach(el => {
    updatePlaceholderForTarget(el);
  });

  // Check all footnotes
  container.querySelectorAll('.footnote-text').forEach(el => {
    updatePlaceholderForTarget(el);
  });
}

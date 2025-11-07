/**
 * Hypercite Clipboard Operations
 *
 * Handles copying hypercites to clipboard and wrapping selected text in DOM.
 * Uses multiple clipboard methods for cross-platform/browser compatibility.
 */

import { generateHyperciteID, selectionSpansMultipleNodes, findParentWithNumericalId } from './utils.js';
import { collectHyperciteData, NewHyperciteIndexedDB } from './database.js';

// Module-level variable to prevent duplicate events
let lastEventTime = 0;

/**
 * Handle copy event for creating hypercites
 * @param {Event} event - The copy event
 * @param {string} bookId - The book ID
 */
export function handleCopyEvent(event, bookId) {
  event.preventDefault();
  event.stopPropagation();

  const now = Date.now();
  if (now - lastEventTime < 300) return;
  lastEventTime = now;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  // This check now uses the passed-in bookId
  if (!bookId) {
    console.error("Book identifier (bookId) was not passed to handleCopyEvent.");
    return;
  }

  const hyperciteId = generateHyperciteID();

  // Get clean text (your existing logic)
  const range = selection.getRangeAt(0);
  let parent = range.commonAncestorContainer;

  if (parent.nodeType === 3) {
    parent = parent.parentElement;
  }

  parent = parent.closest("[id]");

  let selectedText = "";

  if (parent) {
    const parentText = parent.textContent;
    const rangeText = range.toString();

    const startIndex = parentText.indexOf(rangeText);

    if (startIndex !== -1) {
      selectedText = parentText.substring(startIndex, startIndex + rangeText.length).trim();
      console.log("✅ Clean text from parent context:", selectedText);
    } else {
      selectedText = rangeText.trim();
    }
  } else {
    selectedText = selection.toString().trim();
  }

  const currentSiteUrl = `${window.location.origin}`;
  const citationIdA = bookId;
  const hrefA = `${currentSiteUrl}/${citationIdA}#${hyperciteId}`;

  const clipboardHtml = `'${selectedText}'<a href="${hrefA}" id="${hyperciteId}"><sup class="open-icon">↗</sup></a>`;
  const clipboardText = `'${selectedText}' [↗](${hrefA})`;

  console.log("Final clipboard HTML:", clipboardHtml);
  console.log("Final clipboard Text:", clipboardText);

  // SAVE the original selection
  const originalRange = selection.getRangeAt(0).cloneRange();

  let success = false;

  // Method 1: HTML via contentEditable div (most reliable for HTML on mobile)
  try {
    const tempDiv = document.createElement('div');
    tempDiv.contentEditable = true;
    tempDiv.innerHTML = clipboardHtml;
    tempDiv.style.cssText = 'position:absolute;left:-9999px;top:0;opacity:0;pointer-events:none;';

    document.body.appendChild(tempDiv);

    // Focus the div
    tempDiv.focus();

    // Select all content in the div
    const range = document.createRange();
    range.selectNodeContents(tempDiv);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    // Copy immediately while in user gesture context
    success = document.execCommand('copy');

    // Clean up
    document.body.removeChild(tempDiv);

    if (success) {
      console.log("✅ HTML copy via contentEditable success");
    }
  } catch (error) {
    console.warn("contentEditable copy failed:", error);
  }

  // Method 2: Modern API fallback (fire and forget)
  if (!success && navigator.clipboard && window.ClipboardItem) {
    try {
      const clipboardItem = new ClipboardItem({
        'text/html': new Blob([clipboardHtml], { type: 'text/html' }),
        'text/plain': new Blob([clipboardText], { type: 'text/plain' })
      });

      // Fire and forget - don't await to stay synchronous
      navigator.clipboard.write([clipboardItem]).then(() => {
        console.log("✅ Modern API HTML success");
      }).catch(error => {
        console.warn("Modern API failed:", error);
      });

      success = true; // Assume success since we can't wait
    } catch (error) {
      console.warn("Modern API setup failed:", error);
    }
  }

  // Method 3: Plain text fallback
  if (!success) {
    try {
      const tempInput = document.createElement('input');
      tempInput.type = 'text';
      tempInput.value = clipboardText;
      tempInput.style.cssText = 'position:absolute;left:-9999px;top:0;';

      document.body.appendChild(tempInput);
      tempInput.focus();
      tempInput.select();

      success = document.execCommand('copy');
      document.body.removeChild(tempInput);

      if (success) {
        console.log("✅ Plain text fallback success");
      }
    } catch (error) {
      console.warn("Plain text fallback failed:", error);
    }
  }

  if (success) {
    console.log("✅ Clipboard operation completed");
  } else {
    console.error("❌ All clipboard methods failed");
  }

  // RESTORE the original selection
  selection.removeAllRanges();
  selection.addRange(originalRange);

  // Wrap the selected text in the DOM
  try {
    wrapSelectedTextInDOM(hyperciteId, citationIdA);
  } catch (error) {
    console.error("Error wrapping text in DOM:", error);
  }
}

/**
 * Wrap selected text in DOM with hypercite element
 * @param {string} hyperciteId - The hypercite ID
 * @param {string} book - The book ID
 */
export function wrapSelectedTextInDOM(hyperciteId, book) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return console.error("No selection");
  const range = selection.getRangeAt(0);

  // Check if selection spans multiple nodes with IDs
  if (selectionSpansMultipleNodes(range)) {
    // Show warning for multi-node selections
    alert("Apologies: for now, you can't hypercite more than one paragraph or node at a time.");
    setTimeout(() => selection.removeAllRanges(), 50);
    return;
  }

  // Find the nearest ancestor that has any ID at all:
  let parent = range.startContainer.nodeType === 3
    ? range.startContainer.parentElement
    : range.startContainer;
  parent = parent.closest("[id]");
  if (!parent) {
    console.error("No parent with an ID found for hypercite wrapping.");
    return;
  }

  // Now parent.id will be "1.2" or "2.1" etc—no parseInt, no drop!
  const wrapper = document.createElement("u");
  wrapper.id = hyperciteId;
  wrapper.className = "single";
  try {
    const fragment = range.extractContents();
    wrapper.appendChild(fragment);
    range.insertNode(wrapper);
  } catch (e) {
    console.error("Error wrapping selected text:", e);
    return;
  }

  const blocks = collectHyperciteData(hyperciteId, wrapper);
  NewHyperciteIndexedDB(book, hyperciteId, blocks);

  setTimeout(() => selection.removeAllRanges(), 50);
}

/**
 * Fallback copy function for plain text
 * @param {string} text - The text to copy
 */
export function fallbackCopyText(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand("copy"); // Fallback copy for plain text
  } catch (err) {
    console.error("Fallback: Unable to copy text", err);
  }
  document.body.removeChild(textArea);
}

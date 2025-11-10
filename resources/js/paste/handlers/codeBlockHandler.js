/**
 * Code Block Paste Handler
 *
 * Handles pasting into code blocks (<pre> elements).
 * Prevents HTML from being rendered - inserts as plain text instead.
 */

import { queueNodeForSave } from '../../divEditor/index.js';

/**
 * Check if text appears to be complete HTML
 * @param {string} text - Text to check
 * @returns {boolean}
 */
function isCompleteHTML(text) {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("<") &&
    trimmed.endsWith(">") &&
    (trimmed.includes("</") || trimmed.match(/<\s*[a-z]+[^>]*\/>/i))
  );
}

/**
 * Handle paste into code blocks
 * @param {ClipboardEvent} event - Paste event
 * @param {HTMLElement} chunk - Current chunk element
 * @returns {boolean} - True if handled as code block paste
 */
export function handleCodeBlockPaste(event, chunk) {
  const plainText = event.clipboardData.getData("text/plain");
  const htmlContent = event.clipboardData.getData("text/html");

  // Get the current selection and find if we're in a code block
  const selection = window.getSelection();
  if (!selection.rangeCount) return false;

  const range = selection.getRangeAt(0);
  let currentNode = range.startContainer;
  if (currentNode.nodeType !== Node.ELEMENT_NODE) {
    currentNode = currentNode.parentElement;
  }

  // Check if we're in a code block
  const codeBlock = currentNode.closest("pre");
  if (!codeBlock) return false;

  // If we have HTML content and it appears to be complete HTML
  if (htmlContent && isCompleteHTML(plainText)) {
    event.preventDefault();

    // Just insert the plain text directly
    range.deleteContents();
    const textNode = document.createTextNode(plainText);
    range.insertNode(textNode);

    // Update the code block in IndexedDB
    queueNodeForSave(codeBlock.id, 'update');

    return true;
  }

  return false;
}

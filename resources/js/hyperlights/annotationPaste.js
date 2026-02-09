/**
 * Paste module - Handles paste operations in annotation areas
 */

import { sanitizeHtml } from '../utilities/sanitizeConfig.js';
import { parseHyperciteHref, attachUnderlineClickListeners } from "../hypercites/index.js";
import { extractQuotedText } from '../utilities/textExtraction.js';
import { updateCitationForExistingHypercite } from '../indexedDB/index.js';
import { book } from '../app.js';
import { broadcastToOpenTabs } from "../utilities/BroadcastListener.js";
import { saveHighlightAnnotation } from './annotations.js';

/**
 * This is the main paste handler for the annotation area.
 * It now correctly handles preventing the default browser action.
 */
export async function handleHighlightContainerPaste(event, highlightId) {
  // *** THE CRITICAL FIX IS HERE ***
  // We MUST prevent the default action IMMEDIATELY and SYNCHRONOUSLY.
  // This stops the browser from doing its own paste, which caused the "double paste" bug.
  event.preventDefault();

  // Now we can safely get the data and process it asynchronously.
  const clipboardHtml = event.clipboardData.getData("text/html");
  const plainText = event.clipboardData.getData('text/plain');

  // Await the result of the hypercite processor.
  const wasHandledAsHypercite = await processPastedHyperciteInAnnotation(clipboardHtml, highlightId);

  // If it was a hypercite, our job is done. The processor already inserted the content.
  if (wasHandledAsHypercite) {
    return;
  }

  // If it was NOT a hypercite, we handle it as plain text.
  // Because we prevented the default action, we MUST manually insert the text.
  document.execCommand('insertText', false, plainText);

  // After any paste, we save the annotation.
  const annotationDiv = document.querySelector(`.annotation[data-highlight-id="${highlightId}"]`);
  if (annotationDiv) {
    saveHighlightAnnotation(highlightId, annotationDiv.innerHTML);
  }
}

/**
 * This function contains YOUR ORIGINAL, WORKING LOGIC.
 * It is called by the main handler and does not need to worry about the event object.
 */
async function processPastedHyperciteInAnnotation(clipboardHtml, highlightId) {
  if (!clipboardHtml) return false;

  const pasteWrapper = document.createElement("div");
  pasteWrapper.innerHTML = sanitizeHtml(clipboardHtml);

  const citeLink = pasteWrapper.querySelector(
    'a[id^="hypercite_"] > sup.open-icon, a[id^="hypercite_"] > span.open-icon'
  )?.parentElement;

  if (!(citeLink && (citeLink.innerText.trim() === "↗" || (citeLink.closest("span, sup") && (citeLink.closest("span")?.classList.contains("open-icon") || citeLink.closest("sup")?.classList.contains("open-icon")))))) {
    return false;
  }

  console.log("Detected a hypercite in highlight container paste");

  const originalHref = citeLink.getAttribute("href");
  const parsed = parseHyperciteHref(originalHref);
  if (!parsed) return false;

  const { booka, hyperciteIDa, citationIDa } = parsed;
  const hyperciteIDb = "hypercite_" + Math.random().toString(36).substr(2, 8);
  const citationIDb = `/${book}/${highlightId}#${hyperciteIDb}`;

  // Using your original, robust text extraction logic.
  let quotedText = "";
  const quoteMatch = clipboardHtml.match(/'([^']*)'/);
  if (quoteMatch) {
    quotedText = quoteMatch[1];
  }
  if (!quotedText) {
    let textNode = citeLink.previousSibling;
    while (textNode) {
      if (textNode.nodeType === Node.TEXT_NODE) {
        quotedText = textNode.textContent.trim() + quotedText;
        break;
      } else if (textNode.nodeType === Node.ELEMENT_NODE) {
        const textContent = textNode.textContent.trim();
        if (textContent) {
          quotedText = textContent + quotedText;
          break;
        }
      }
      textNode = textNode.previousSibling;
    }
  }
  if (!quotedText) {
    quotedText = extractQuotedText(pasteWrapper);
  }
  quotedText = quotedText.replace(/^['"]|['"]$/g, '');

  const referenceHtml = `'${quotedText}<span style="white-space:nowrap">'<a href="${originalHref}" id="${hyperciteIDb}"><sup class="open-icon">↗</sup></a></span>`;

  // Manually insert the clean HTML.
  document.execCommand("insertHTML", false, referenceHtml);

  // Attach click listeners to the newly inserted hypercite link
  setTimeout(() => {
    attachUnderlineClickListeners();
  }, 100);

  // Update the original hypercite in the database.
  try {
    const updateResult = await updateCitationForExistingHypercite(
      booka,
      hyperciteIDa,
      citationIDb
    );
    if (updateResult && updateResult.success) {
      console.log(`Successfully linked: ${citationIDa} cited in ${citationIDb}`);
      // Broadcast the update to trigger DOM updates on the current page
      broadcastToOpenTabs(booka, updateResult.startLine);
    }
  } catch (error) {
    console.error("Error during hypercite paste update:", error);
  }

  return true; // Signal that we successfully handled this.
}

/**
 * This function attaches the paste listener. It is correct.
 */
export function addHighlightContainerPasteListener(highlightId) {
  const container = document.getElementById("hyperlit-container");
  if (!container) return;

  const annotationDiv = container.querySelector(
    `.annotation[data-highlight-id="${highlightId}"]`
  );
  if (!annotationDiv) return;

  annotationDiv.removeEventListener("paste", annotationDiv._pasteHandler);
  annotationDiv._pasteHandler = (event) => handleHighlightContainerPaste(event, highlightId);
  annotationDiv.addEventListener("paste", annotationDiv._pasteHandler);
}

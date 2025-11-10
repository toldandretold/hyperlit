/**
 * Hypercite Paste Handler
 *
 * Handles pasting of hypercites (citations with bidirectional linking).
 * Updates citedIN arrays and relationship statuses in both source and target documents.
 */

import { book } from '../../app.js';
import {
  updateCitationForExistingHypercite,
  getNodeChunksFromIndexedDB,
  addCitationToHypercite,
  getHyperciteFromIndexedDB,
  updateHyperciteInIndexedDB,
  getNodeChunkFromIndexedDB,
  toPublicChunk
} from '../../indexedDB/index.js';
import { parseHyperciteHref } from '../../hypercites/index.js';
import { broadcastToOpenTabs } from '../../utilities/BroadcastListener.js';
import {
  setHandleHypercitePaste
} from '../../utilities/operationState.js';
import { queueNodeForSave } from '../../divEditor/index.js';

/**
 * Extract quoted text before a hypercite link element
 * @param {HTMLElement} container - Container holding the link
 * @param {HTMLElement} linkElement - The link element
 * @returns {string} - Cleaned quoted text
 */
function extractQuotedTextBeforeLink(container, linkElement) {
  // Method 1: Try to find text node immediately before the link
  let textNode = linkElement.previousSibling;
  let quotedText = "";

  while (textNode) {
    if (textNode.nodeType === Node.TEXT_NODE) {
      const text = textNode.textContent.trim();
      if (text) {
        quotedText = text + quotedText;
        break;
      }
    } else if (textNode.nodeType === Node.ELEMENT_NODE) {
      // Check if it's a span or other element containing text
      const textContent = textNode.textContent.trim();
      if (textContent) {
        quotedText = textContent + quotedText;
        break;
      }
    }
    textNode = textNode.previousSibling;
  }

  // Method 2: If no text found, try regex on container's text content
  if (!quotedText) {
    const fullText = container.textContent;
    const quoteMatch = fullText.match(/[''""]([^]*?)[''""](?=\s*↗|$)/);
    if (quoteMatch && quoteMatch[1]) {
      quotedText = quoteMatch[1];
    }
  }

  // Clean up quotes from start and end
  quotedText = quotedText.replace(/^[''""]/, '').replace(/[''""]$/, '');

  return quotedText;
}

/**
 * Extract quoted text from a paste wrapper element
 * Moved to utilities/textExtraction.js to avoid circular dependencies
 */
export { extractQuotedText } from '../../utilities/textExtraction.js';

/**
 * Save the current paragraph after a paste operation
 */
export function saveCurrentParagraph() {
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    let currentElement = range.startContainer;
    if (currentElement.nodeType !== Node.ELEMENT_NODE) {
      currentElement = currentElement.parentElement;
    }

    // Find the closest block element (paragraph, pre, blockquote, etc.)
    let blockElement = currentElement.closest('p, pre, blockquote, h1, h2, h3, h4, h5, h6');

    if (blockElement && blockElement.id) {
      console.log("Manually saving block element:", blockElement.id, blockElement.tagName);
      // Manually save the element to IndexedDB
      queueNodeForSave(blockElement.id, 'update');
    }
  }
}

/**
 * Handle pasting of hypercites
 * @param {ClipboardEvent} event - Paste event
 * @returns {Promise<boolean>} true if handled as hypercite, false otherwise
 */
export async function handleHypercitePaste(event) {
  const clipboardHtml = event.clipboardData.getData("text/html");
  if (!clipboardHtml) return false;

  // Parse clipboard HTML
  const pasteWrapper = document.createElement("div");
  pasteWrapper.innerHTML = clipboardHtml;

  // Clear any numeric IDs to prevent conflicts
  pasteWrapper.querySelectorAll('[id]').forEach(el => {
    if (/^\d+(\.\d+)?$/.test(el.id)) {
      el.removeAttribute('id');
    }
  });

  // Look for hypercite link by href pattern (more reliable than id attribute)
  // Browsers may not preserve id or class attributes when copying, but href is always preserved
  const links = pasteWrapper.querySelectorAll('a[href*="#hypercite_"]');
  const citeLinks = []; // Collect ALL valid hypercite links

  console.log('🔍 Checking for hypercite links:', {
    foundLinks: links.length,
    pasteWrapperHTML: pasteWrapper.innerHTML.substring(0, 200)
  });

  // Find all links that have sup/span child with arrow (class may be stripped by browser)
  for (const link of links) {
    const hasSupOrSpan = link.querySelector('sup, span');
    // Remove all whitespace and zero-width spaces to handle \u200B from hypercite creation
    const linkText = link.innerText.replace(/[\u200B\s]/g, '');
    if (hasSupOrSpan && linkText === "↗") {
      citeLinks.push(link);
    }
  }

  // Check if this paste contains hypercite links
  if (citeLinks.length === 0) {
    return false; // Not a hypercite paste
  }

  console.log(`✅ Found ${citeLinks.length} hypercite link(s) in paste`);

  // Prevent default paste behavior
  event.preventDefault();

  console.log(`Detected ${citeLinks.length} hypercite(s) in pasted content`);

  // Get current book (where paste is happening)
  const bookb = book;

  // Process all hypercite links and build combined HTML
  let combinedHtml = '';
  const updateTasks = []; // Store update promises to await later

  for (const citeLink of citeLinks) {
    const originalHref = citeLink.getAttribute("href");
    const parsed = parseHyperciteHref(originalHref);

    if (!parsed) {
      console.warn("Failed to parse hypercite href:", originalHref);
      continue; // Skip this link and continue with others
    }

    const { booka, hyperciteIDa, citationIDa } = parsed;
    console.log("Parsed citation info:", { booka, hyperciteIDa, citationIDa });

    // Generate new hypercite ID for this instance
    const hyperciteIDb = "hypercite_" + Math.random().toString(36).substr(2, 8);

    // Create the citation ID for this new instance
    const citationIDb = `/${bookb}#${hyperciteIDb}`;

    // Extract quoted text using helper function
    let quotedText = extractQuotedTextBeforeLink(pasteWrapper, citeLink);

    // Fallback to old extraction method if helper fails
    if (!quotedText) {
      quotedText = extractQuotedText(pasteWrapper);
    }

    console.log(`🔍 Extracted quoted text for link ${citeLinks.indexOf(citeLink) + 1}:`, `"${quotedText}"`);

    // Add to combined HTML (with space between multiple hypercites)
    if (combinedHtml) combinedHtml += ' ';
    combinedHtml += `'${quotedText}'<a href="${originalHref}" id="${hyperciteIDb}">\u200B<sup class="open-icon">↗</sup></a>`;

    // Store update task to process after insertion
    updateTasks.push({
      booka,
      hyperciteIDa,
      citationIDb,
      citationIDa
    });
  }

  // Check if we successfully processed any hypercites
  if (!combinedHtml) {
    console.warn("No valid hypercites were processed");
    return false;
  }

  console.log(`📝 Built combined HTML for ${updateTasks.length} hypercite(s)`);

  // Set the flag to prevent MutationObserver from processing this paste
  setHandleHypercitePaste(true);
  console.log("setHandleHypercitePaste flag to true");

  // Insert the combined content - use a more controlled approach
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);

    // Create a document fragment with all the hypercite links
    const fragment = document.createDocumentFragment();
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = combinedHtml;

    // Move all nodes from tempDiv to fragment
    while (tempDiv.firstChild) {
      fragment.appendChild(tempDiv.firstChild);
    }

    // Clear the range and insert our clean fragment
    range.deleteContents();
    range.insertNode(fragment);

    // Move cursor to end of insertion
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    // Fallback to execCommand if selection isn't available
    document.execCommand("insertHTML", false, combinedHtml);
  }

  // Get the current paragraph to manually save it
  saveCurrentParagraph();

  // Update all original hypercites' citedIN arrays
  // Use batched sync for multiple hypercites to avoid 429 rate limiting
  const shouldBatch = updateTasks.length > 1;

  try {
    console.log(`🔄 Updating ${updateTasks.length} original hypercite(s)... (${shouldBatch ? 'BATCHED' : 'IMMEDIATE'} sync)`);

    if (!shouldBatch) {
      // SINGLE HYPERCITE: Use existing immediate sync behavior
      for (const task of updateTasks) {
        const { booka, hyperciteIDa, citationIDb, citationIDa } = task;

        try {
          const updateResult = await updateCitationForExistingHypercite(
            booka,
            hyperciteIDa,
            citationIDb
          );

          if (updateResult && updateResult.success) {
            console.log(`✅ Successfully linked: ${citationIDa} cited in ${citationIDb}`);

            // Update the DOM in the CURRENT tab
            const localElement = document.getElementById(hyperciteIDa);
            if (localElement) {
              console.log(`(Paste Handler) Updating local DOM for ${hyperciteIDa} to class: ${updateResult.newStatus}`);
              localElement.className = updateResult.newStatus;
            }

            // Broadcast to OTHER tabs
            broadcastToOpenTabs(booka, updateResult.startLine);

          } else {
            console.warn(`⚠️ Failed to update citation for ${citationIDa}`);
          }
        } catch (error) {
          console.error(`❌ Error updating hypercite ${hyperciteIDa}:`, error);
          // Continue processing other hypercites even if one fails
        }
      }
    } else {
      // MULTIPLE HYPERCITES: Batch all updates into ONE request
      const updatedHypercites = [];
      const updatedNodeChunks = [];
      const domUpdates = []; // Store DOM updates to apply after successful sync

      // Process all hypercites and collect updates
      for (const task of updateTasks) {
        const { booka, hyperciteIDa, citationIDb, citationIDa } = task;

        try {
          // 1. Find and update the hypercite in nodeChunks
          const nodeChunks = await getNodeChunksFromIndexedDB(booka);
          if (!nodeChunks?.length) {
            console.warn(`No nodes found for book ${booka}`);
            continue;
          }

          let affectedStartLine = null;
          let updatedRelationshipStatus = "single";

          for (const record of nodeChunks) {
            if (!record.hypercites?.find((hc) => hc.hyperciteId === hyperciteIDa)) {
              continue;
            }
            const startLine = record.startLine;
            const result = await addCitationToHypercite(
              booka,
              startLine,
              hyperciteIDa,
              citationIDb
            );
            if (result.success) {
              affectedStartLine = startLine;
              updatedRelationshipStatus = result.relationshipStatus;
              break;
            }
          }

          if (!affectedStartLine) {
            console.warn(`No matching hypercite found in book ${booka} with ID ${hyperciteIDa}`);
            continue;
          }

          // 2. Update the hypercite record itself
          const existingHypercite = await getHyperciteFromIndexedDB(booka, hyperciteIDa);
          if (!existingHypercite) {
            console.error(`Hypercite ${hyperciteIDa} not found in book ${booka}`);
            continue;
          }

          existingHypercite.citedIN ||= [];
          if (!existingHypercite.citedIN.includes(citationIDb)) {
            existingHypercite.citedIN.push(citationIDb);
          }
          existingHypercite.relationshipStatus = updatedRelationshipStatus;

          const hyperciteSuccess = await updateHyperciteInIndexedDB(
            booka,
            hyperciteIDa,
            {
              citedIN: existingHypercite.citedIN,
              relationshipStatus: updatedRelationshipStatus,
              hypercitedHTML: `<u id="${hyperciteIDa}" class="${updatedRelationshipStatus}">${existingHypercite.hypercitedText}</u>`,
            },
            true // skipQueue: we're doing batched sync immediately
          );

          if (!hyperciteSuccess) {
            console.error(`Failed to update hypercite ${hyperciteIDa}`);
            continue;
          }

          // 3. Get final records for sync
          const finalHyperciteRecord = await getHyperciteFromIndexedDB(booka, hyperciteIDa);
          const finalNodeChunkRecord = await getNodeChunkFromIndexedDB(booka, affectedStartLine);

          if (finalHyperciteRecord && finalNodeChunkRecord) {
            // Add to batch collections
            updatedHypercites.push(finalHyperciteRecord);
            updatedNodeChunks.push(toPublicChunk(finalNodeChunkRecord));

            // Store DOM update for later
            domUpdates.push({
              hyperciteIDa,
              newStatus: updatedRelationshipStatus,
              startLine: affectedStartLine,
              booka,
              citationIDa
            });

            console.log(`✅ Prepared batch update for: ${citationIDa} cited in ${citationIDb}`);
          }
        } catch (error) {
          console.error(`❌ Error processing hypercite ${hyperciteIDa}:`, error);
          // Continue processing other hypercites even if one fails
        }
      }

      // 4. Make ONE batched API call for all hypercites
      if (updatedHypercites.length > 0) {
        console.log(`📤 Syncing ${updatedHypercites.length} hypercite(s) in ONE batched request...`);

        try {
          // Group hypercites by book for batching
          const hypercitesByBook = {};
          updatedHypercites.forEach(hc => {
            if (!hypercitesByBook[hc.book]) {
              hypercitesByBook[hc.book] = [];
            }
            hypercitesByBook[hc.book].push(hc);
          });

          // Sync each book's hypercites
          const hyperciteSyncPromises = Object.entries(hypercitesByBook).map(([book, hypercites]) =>
            fetch("/api/db/hypercites/upsert", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-TOKEN": document.querySelector('meta[name="csrf-token"]')?.getAttribute("content"),
              },
              credentials: "include",
              body: JSON.stringify({ book, data: hypercites }),
            })
          );

          // Group nodeChunks by book for batching
          const nodeChunksByBook = {};
          updatedNodeChunks.forEach(nc => {
            if (!nodeChunksByBook[nc.book]) {
              nodeChunksByBook[nc.book] = [];
            }
            nodeChunksByBook[nc.book].push(nc);
          });

          // Sync each book's nodeChunks
          const nodeChunkSyncPromises = Object.entries(nodeChunksByBook).map(([book, chunks]) =>
            fetch("/api/db/node-chunks/targeted-upsert", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-TOKEN": document.querySelector('meta[name="csrf-token"]')?.getAttribute("content"),
              },
              credentials: "include",
              body: JSON.stringify({ book, data: chunks }),
            })
          );

          // Wait for all sync operations to complete
          const allResponses = await Promise.all([...hyperciteSyncPromises, ...nodeChunkSyncPromises]);

          // Check if all requests succeeded
          const allSucceeded = allResponses.every(res => res.ok);

          if (allSucceeded) {
            console.log(`✅ Batched sync successful for ${updatedHypercites.length} hypercite(s)`);

            // 5. Apply DOM updates only after successful sync
            domUpdates.forEach(({ hyperciteIDa, newStatus, startLine, booka }) => {
              const localElement = document.getElementById(hyperciteIDa);
              if (localElement) {
                console.log(`(Paste Handler) Updating local DOM for ${hyperciteIDa} to class: ${newStatus}`);
                localElement.className = newStatus;
              }

              // Broadcast to OTHER tabs
              broadcastToOpenTabs(booka, startLine);
            });
          } else {
            console.error('❌ Some batched sync requests failed');
            allResponses.forEach((res, idx) => {
              if (!res.ok) {
                console.error(`Request ${idx + 1} failed with status: ${res.status}`);
              }
            });
          }
        } catch (error) {
          console.error('❌ Error during batched sync:', error);
        }
      }
    }

    console.log(`✅ Completed updating ${updateTasks.length} hypercite(s)`);

  } catch (error) {
    console.error("❌ Error during hypercite paste updates:", error);
  } finally {
    // Clear the flag in the finally block to guarantee it's always reset
    setHandleHypercitePaste(false);
    console.log("setHandleHypercitePaste cleared");
  }

  return true; // Successfully handled as hypercite
}

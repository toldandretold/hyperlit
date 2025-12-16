/**
 * Small Paste Handler
 *
 * Handles paste operations with ≤10 nodes using fast browser insertion.
 * Uses execCommand('insertHTML') and fixes IDs afterward.
 */

import { generateIdBetween, setElementIds, generateNodeId } from '../../utilities/IDfunctions.js';
import { queueNodeForSave } from '../../divEditor/index.js';
import DOMPurify from 'dompurify';

const SMALL_NODE_LIMIT = 10;

/**
 * Handle small paste operations (≤ SMALL_NODE_LIMIT nodes)
 * @param {Event} event - The paste event
 * @param {string} htmlContent - Processed HTML content (from markdown or sanitized)
 * @param {string} plainText - Original plain text
 * @param {number} nodeCount - Estimated node count
 * @param {string} book - Current book ID
 * @returns {boolean} - True if handled, false if should continue to large paste handler
 */
export function handleSmallPaste(event, htmlContent, plainText, nodeCount, book) {
  if (nodeCount > SMALL_NODE_LIMIT) {
    return false; // Not a small paste, continue to large paste handler
  }

  console.log(
    `Small paste (≈${nodeCount} nodes); handling with browser insertion and ID fix-up.`
  );

  // --- 1. PREPARE THE CONTENT (initial) ---
  // SECURITY: Sanitize HTML content to prevent XSS
  let finalHtmlToInsert = htmlContent ? DOMPurify.sanitize(htmlContent, { USE_PROFILES: { html: true } }) : null;

  // --- 2. GET INSERTION CONTEXT (BEFORE PASTING) ---
  const selection = window.getSelection();
  if (!selection.rangeCount) return true;

  const range = selection.getRangeAt(0);
  let currentElement = range.startContainer;
  if (currentElement.nodeType === Node.TEXT_NODE) {
    currentElement = currentElement.parentElement;
  }

  let currentBlock = currentElement.closest(
    "p, h1, h2, h3, h4, h5, h6, div, pre, blockquote"
  );

  if (
    !currentBlock ||
    !currentBlock.id ||
    !/^\d+(\.\d+)*$/.test(currentBlock.id)
  ) {
    console.warn(
      "Small paste aborted: Could not find a valid anchor block with a numerical ID."
    );
    // Allow native paste as a fallback in this edge case.
    return false;
  }

  // --- 2.5. FINALIZE CONTENT PREPARATION (now that we have currentBlock) ---

  // If we only have plain text, convert it to structured HTML.
  if (!finalHtmlToInsert && plainText) {
    const parts = plainText
      .split(/\n\s*\n/) // Split on blank lines
      .filter((p) => p.trim());

    // Don't wrap in <p> if we're already inside a block element
    if (parts.length === 1 && currentBlock) {
      finalHtmlToInsert = parts[0];
    } else {
      finalHtmlToInsert = parts.map((p) => `<p>${p}</p>`).join("");
    }
  }

  // If pasting HTML with a single <p> wrapper into an existing <p>, unwrap it
  if (finalHtmlToInsert && currentBlock) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = finalHtmlToInsert;

    // Check if content is a single <p> tag
    if (tempDiv.children.length === 1 && tempDiv.children[0].tagName === 'P') {
      // Unwrap: use innerHTML of the <p> instead of the entire <p>
      finalHtmlToInsert = tempDiv.children[0].innerHTML;
      console.log(`Unwrapped <p> tag to prevent nesting in paste`);
    }
  }

  // If there's nothing to insert, we're done.
  if (!finalHtmlToInsert) {
    return true;
  }

  // --- 3. PERFORM THE PASTE ---
  event.preventDefault(); // Take control from the browser!

  // Save currentBlock's data-node-id before paste (execCommand may replace the element)
  const savedNodeId = currentBlock ? currentBlock.getAttribute('data-node-id') : null;
  const savedBlockId = currentBlock ? currentBlock.id : null;

  // Check if we're pasting into an H1 AND pasting block-level content
  const isH1Destination = currentBlock && currentBlock.tagName === 'H1';

  // Detect if pasted content contains block-level elements
  let hasBlockElements = false;
  if (isH1Destination && finalHtmlToInsert) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = finalHtmlToInsert;
    hasBlockElements = tempDiv.querySelector('p, h1, h2, h3, h4, h5, h6, div, blockquote, ul, ol, pre') !== null;
  }

  if (isH1Destination && hasBlockElements) {
    console.log(`H1 destination with block-level content - using manual insertion to prevent nesting`);

    // Parse the HTML content to extract individual blocks
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = finalHtmlToInsert;
    const blocks = Array.from(tempDiv.children);

    if (blocks.length > 0) {
      // 1. Replace H1 content with first block's content (but keep it as H1)
      const firstBlock = blocks[0];
      if (firstBlock.tagName === 'H1') {
        // If first pasted block is also H1, use its content
        currentBlock.innerHTML = firstBlock.innerHTML;
      } else {
        // Convert first pasted block content to H1 content
        currentBlock.innerHTML = firstBlock.innerHTML;
      }

      // 2. Insert remaining blocks AFTER the H1 as siblings
      let insertAfter = currentBlock;
      for (let i = 1; i < blocks.length; i++) {
        const blockToInsert = blocks[i].cloneNode(true);
        insertAfter.parentNode.insertBefore(blockToInsert, insertAfter.nextSibling);
        insertAfter = blockToInsert;
      }

      console.log(`Manually inserted ${blocks.length} blocks: 1 into H1, ${blocks.length - 1} as siblings`);
    }
  } else {
    // Normal paste - use execCommand (safe for text/inline content or non-H1 destinations)
    document.execCommand("insertHTML", false, finalHtmlToInsert);
  }

  // --- 4. FIX-UP: ASSIGN IDS TO NEWLY CREATED ELEMENTS ---
  console.log("Fix-up phase: Scanning for new nodes to assign IDs.");

  // The original block was modified, so save it.
  queueNodeForSave(currentBlock.id, "update");

  // Re-query currentBlock by ID (execCommand may have replaced it in DOM)
  const liveCurrentBlock = savedBlockId ? document.getElementById(savedBlockId) : null;

  if (liveCurrentBlock) {
    // Restore data-node-id if element was replaced by execCommand
    if (savedNodeId && !liveCurrentBlock.getAttribute('data-node-id')) {
      liveCurrentBlock.setAttribute('data-node-id', savedNodeId);
      console.log(`Restored data-node-id to element #${savedBlockId} after paste`);
    } else if (!liveCurrentBlock.getAttribute('data-node-id')) {
      // No saved node ID, generate a new one
      const newNodeId = generateNodeId(book);
      liveCurrentBlock.setAttribute('data-node-id', newNodeId);
      console.log(`Added new data-node-id to element #${savedBlockId}`);
    }
    // Update reference for subsequent loop
    currentBlock = liveCurrentBlock;
  } else {
    console.warn(`Could not find element #${savedBlockId} after paste - element may have been removed`);

    // 🐛 FIX: Element was replaced by paste - find the selection position to locate new elements
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      let node = selection.getRangeAt(0).startContainer;

      // Get to an element node
      if (node.nodeType === Node.TEXT_NODE) {
        node = node.parentElement;
      }

      // Find the closest block-level element
      currentBlock = node.closest('p, h1, h2, h3, h4, h5, h6, div, pre, blockquote');

      if (currentBlock) {
        console.log(`Found replacement element via selection: ${currentBlock.tagName}#${currentBlock.id || '(no id)'}`);

        // If found element has no ID, try to find previous sibling with ID
        if (!currentBlock.id || !/^\d+(\.\d+)*$/.test(currentBlock.id)) {
          // Try to use the saved ID from before paste
          if (savedBlockId) {
            // Check if there's a previous sibling with an ID we can use as reference
            let prevSibling = currentBlock.previousElementSibling;
            while (prevSibling && (!prevSibling.id || !/^\d+(\.\d+)*$/.test(prevSibling.id))) {
              prevSibling = prevSibling.previousElementSibling;
            }

            const prevId = prevSibling ? prevSibling.id : null;
            const nextSibling = currentBlock.nextElementSibling;
            let nextId = null;
            if (nextSibling && /^\d+(\.\d+)*$/.test(nextSibling.id)) {
              nextId = nextSibling.id;
            }

            // Assign ID to this first pasted element
            setElementIds(currentBlock, prevId, nextId, book);
            console.log(`Assigned ID ${currentBlock.id} to first pasted element`);
            queueNodeForSave(currentBlock.id, "add");
          }
        }
      }
    }
  }

  // 🐛 FIX: If currentBlock was just found and has an ID, queue it for save
  if (currentBlock && currentBlock.id && /^\d+(\.\d+)*$/.test(currentBlock.id)) {
    // Only queue if it's a new element (doesn't have saved node-id from before paste)
    if (!savedNodeId || currentBlock.getAttribute('data-node-id') !== savedNodeId) {
      queueNodeForSave(currentBlock.id, "add");
      console.log(`Queued currentBlock ${currentBlock.id} for save`);
    }
  }

  // Find the ID of the next "stable" node that already has an ID.
  let nextStableElement = currentBlock ? currentBlock.nextElementSibling :
    currentElement.closest(".chunk")?.firstElementChild?.nextElementSibling;
  while (
    nextStableElement &&
    (!nextStableElement.id || !/^\d+(\.\d+)*$/.test(nextStableElement.id))
  ) {
    nextStableElement = nextStableElement.nextElementSibling;
  }
  const nextStableNodeId = nextStableElement ? nextStableElement.id : null;

  // Now, iterate through the new nodes between our original block and the next stable one.
  // 🐛 FIX: Safety check - if currentBlock is null, can't assign IDs
  if (!currentBlock) {
    console.error('❌ Cannot assign IDs: currentBlock is null after paste. Pasted elements will have no IDs!');
    return;
  }

  // 🐛 FIX: First, go BACKWARDS from currentBlock to assign IDs to earlier pasted elements
  let prevElement = currentBlock.previousElementSibling;
  const elementsToProcessBackwards = [];

  while (prevElement) {
    // Stop if we hit an element with a valid ID (stable element)
    if (prevElement.id && /^\d+(\.\d+)*$/.test(prevElement.id)) {
      break;
    }

    // Collect elements that need IDs
    if (prevElement.matches("p, h1, h2, h3, h4, h5, h6, div, pre, blockquote")) {
      elementsToProcessBackwards.unshift(prevElement); // Add to front to maintain order
    }

    prevElement = prevElement.previousElementSibling;
  }

  // Find the ID before the first pasted element
  const firstPrevId = prevElement?.id || null;

  // Assign IDs to backward elements
  let lastAssignedId = firstPrevId;
  elementsToProcessBackwards.forEach(element => {
    if (!element.id || !/^\d+(\.\d+)*$/.test(element.id)) {
      setElementIds(element, lastAssignedId, currentBlock.id, book);
      console.log(`Assigned ID ${element.id} to earlier pasted element`);
      queueNodeForSave(element.id, "add");
      lastAssignedId = element.id;
    }
  });

  // Now proceed with FORWARD loop as before
  let lastKnownId = currentBlock.id;
  let elementToProcess = currentBlock.nextElementSibling;

  while (elementToProcess && elementToProcess !== nextStableElement) {
    // Process all block-level elements to ensure they have both id and data-node-id
    if (elementToProcess.matches("p, h1, h2, h3, h4, h5, h6, div, pre, blockquote")) {
      const hasValidId = elementToProcess.id && /^\d+(\.\d+)*$/.test(elementToProcess.id);
      const hasNodeId = elementToProcess.getAttribute('data-node-id');

      if (!hasValidId) {
        // Element needs a new numerical ID (and data-node-id)
        const newId = setElementIds(elementToProcess, lastKnownId, nextStableNodeId, book);
        console.log(`Assigned new ID ${newId} to pasted element.`);
        queueNodeForSave(newId, "add");
        lastKnownId = newId;
      } else if (!hasNodeId) {
        // Element has valid numerical ID but missing data-node-id
        elementToProcess.setAttribute('data-node-id', generateNodeId(book));
        console.log(`Added data-node-id to pasted element with existing ID ${elementToProcess.id}`);
        queueNodeForSave(elementToProcess.id, "add");
        lastKnownId = elementToProcess.id;
      } else {
        // Element has both IDs - CHECK if the ID is valid for this position
        const elementId = parseFloat(elementToProcess.id);
        const lastKnownNum = parseFloat(lastKnownId);
        const nextStableNum = nextStableNodeId ? parseFloat(nextStableNodeId) : null;

        // Validate: Is this ID in the correct sequential position?
        const needsNewId =
          elementId <= lastKnownNum || // ID is not greater than previous
          (nextStableNum && elementId >= nextStableNum); // ID is not less than next

        if (needsNewId) {
          // Generate new positional ID, but PRESERVE existing data-node-id
          const existingNodeId = elementToProcess.getAttribute('data-node-id');
          const newId = generateIdBetween(lastKnownId, nextStableNodeId);
          elementToProcess.id = newId;
          console.log(`Updated pasted element ID: ${elementToProcess.id} → ${newId} (preserved data-node-id: ${existingNodeId})`);
          queueNodeForSave(newId, 'update'); // Update since it has existing node_id
          lastKnownId = newId;
        } else {
          // ID is already correct for this position
          console.log(`Pasted element ID ${elementToProcess.id} is valid for position`);
          lastKnownId = elementToProcess.id;
        }
      }
    }
    elementToProcess = elementToProcess.nextElementSibling;
  }

  // --- 5. FINALIZE ---
  // The cursor is already placed correctly by execCommand.
  return true; // We handled it.
}

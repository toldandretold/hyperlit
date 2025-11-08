import { updateIndexedDBRecordForNormalization } from "../indexedDB.js";
import { getAllNodeChunksForBook, renumberNodeChunksInIndexedDB } from "../indexedDB.js";
import { syncIndexedDBtoPostgreSQL } from "../postgreSQL.js";
import { book } from "../app.js";
import { showTick, showError } from "../components/editIndicator.js";

// Renumbering system: When IDs get crowded, renumber with 100-gaps
// Uses node_id as stable reference to preserve node identity

// Track if renumbering is in progress
let isRenumberingInProgress = false;
let renumberingPromise = null;

// Create renumbering modal (similar to paste.js conversion modal)
const renumberModal = document.createElement("div");
renumberModal.id = "renumber-modal";
renumberModal.style.cssText = `
  position: fixed;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(34, 31, 32, 0.95);
  z-index: 10000;
  color: #CBCCCC;
  pointer-events: all;
`;
renumberModal.innerHTML = `
  <div style="
    background: #CBCCCC;
    padding: 2em 3em;
    border-radius: 4px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    font: 16px sans-serif;
    color: #221F20;
    text-align: center;
  ">
    <p id="renumber-message" style="margin:0 0 1em 0; font-weight: bold;">
      Renumbering document nodes...
    </p>
    <p id="renumber-details" style="margin:0; font-size: 14px; color: #666;">
      Please wait...
    </p>
  </div>
`;

// Append modal when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    document.body.appendChild(renumberModal);
  });
} else {
  if (document.body) {
    document.body.appendChild(renumberModal);
  }
}

async function showRenumberModal(message, details = '') {
  renumberModal.querySelector("#renumber-message").textContent = message;
  renumberModal.querySelector("#renumber-details").textContent = details;
  renumberModal.style.display = "flex";
  // Wait two frames to ensure it's painted
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
}

function hideRenumberModal() {
  renumberModal.style.display = "none";
}

/**
 * Trigger renumbering with UI modal (non-blocking)
 */
export async function triggerRenumberingWithModal(delayMs = 100) {
  // Prevent multiple renumbering operations - return existing promise
  if (isRenumberingInProgress && renumberingPromise) {
    console.log('⏸️ Renumbering already in progress - returning existing promise');
    return renumberingPromise;
  }

  isRenumberingInProgress = true;

  // Create promise that resolves when renumbering completes
  renumberingPromise = (async () => {
    try {
      // Wait for specified delay to allow mutation observer to process new elements
      if (delayMs > 0) {
        console.log(`⏰ Waiting ${delayMs}ms for mutation observer to process new elements...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      await showRenumberModal('Renumbering document...', 'Reorganizing node IDs with 100-unit gaps');
      await renumberAllNodes();
      // renumberAllNodes() handles modal hiding and flag reset on success
      return true;
    } catch (error) {
      console.error('❌ Renumbering failed:', error);
      hideRenumberModal();
      isRenumberingInProgress = false;
      renumberingPromise = null;
      alert('Renumbering failed. Please try again.');
      throw error;
    }
  })();

  return renumberingPromise;
}

/**
 * Renumber all nodes in the current book with 100-unit gaps
 * Called when we'd be forced to create a decimal ID
 */
async function renumberAllNodes() {
  console.log('🔄 RENUMBERING: Starting system-wide ID renormalization');

  try {
    // 0. Flush all pending saves to IndexedDB first
    console.log('💾 Flushing all pending saves before renumbering...');
    const { flushAllPendingSaves } = await import('../divEditor.js');
    await flushAllPendingSaves();
    console.log('✅ All pending saves flushed');

    // 1. Get all nodes from IndexedDB, sorted by current startLine
    const allNodes = await getAllNodeChunksForBook(book);
    if (!allNodes || allNodes.length === 0) {
      console.warn('⚠️ RENUMBERING: No nodes found for book:', book);
      return false;
    }

    // Sort by current startLine to preserve order
    allNodes.sort((a, b) => a.startLine - b.startLine);

    console.log(`🔄 RENUMBERING: Processing ${allNodes.length} nodes`);

    // 2. Build mapping: node_id → new startLine (with 100-gaps)
    const updates = [];
    allNodes.forEach((node, index) => {
      const newStartLine = (index + 1) * 100; // 100, 200, 300, etc.
      const oldStartLine = node.startLine;

      // Update HTML content to reflect new ID (like paste.js does)
      // This updates the stored HTML regardless of whether node is in DOM
      const updatedContent = node.content.replace(
        /id="[\d.]+"/g,
        `id="${newStartLine}"`
      );

      updates.push({
        book: book,
        oldStartLine: oldStartLine,
        newStartLine: newStartLine,
        node_id: node.node_id,
        content: updatedContent,
        chunk_id: Math.floor(index / 100), // Recalculate chunk_id
        hyperlights: node.hyperlights || [],
        hypercites: node.hypercites || [],
        footnotes: node.footnotes || []
      });
    });

    console.log(`🔄 RENUMBERING: Generated ${updates.length} updates`);

    // 3. Set flag to ignore mutation observer during DOM/DB updates
    window.renumberingInProgress = true;
    console.log('🔒 RENUMBERING: Mutation observer disabled');

    // 4. Update DOM elements if they're currently visible (using node_id as stable reference)
    let domUpdateCount = 0;
    let missingElements = 0;

    // Also check for DOM elements that aren't in the updates array
    const allDomElements = document.querySelectorAll('[data-node-id]');
    const updatesNodeIds = new Set(updates.map(u => u.node_id));

    allDomElements.forEach(el => {
      const nodeId = el.getAttribute('data-node-id');
      if (!updatesNodeIds.has(nodeId)) {
        console.warn(`⚠️ DOM element with node_id ${nodeId} (id="${el.id}") NOT in updates array - was not saved to IndexedDB yet`);
      }
    });

    updates.forEach(update => {
      const element = document.querySelector(`[data-node-id="${update.node_id}"]`);
      if (element) {
        const oldId = element.id;
        element.id = update.newStartLine.toString();
        domUpdateCount++;
        if (oldId.includes('.')) {
          console.log(`🔄 Updated decimal ID: ${oldId} → ${update.newStartLine}`);
        }
      } else {
        missingElements++;
      }
    });
    console.log(`✅ RENUMBERING: Updated ${domUpdateCount} DOM elements (${missingElements} not in DOM)`);

    // 5. Update IndexedDB with new startLines
    await renumberNodeChunksInIndexedDB(updates, book);
    console.log('✅ RENUMBERING: IndexedDB updated');

    // 6. Sync to PostgreSQL
    await syncIndexedDBtoPostgreSQL(book);
    console.log('✅ RENUMBERING: PostgreSQL synced');

    // Show green tick to indicate successful sync
    showTick();

    // 7. Clear any pending syncs queued during the process (they have stale pre-renumber data)
    const { clearPendingSyncsForBook } = await import('../indexedDB.js');
    const clearedCount = clearPendingSyncsForBook(book);
    console.log(`✅ RENUMBERING: Cleared ${clearedCount} stale pending syncs`);

    // 8. Re-enable mutation observer
    window.renumberingInProgress = false;
    console.log('🔓 RENUMBERING: Mutation observer re-enabled');

    // 8. Update lazy loader's in-memory cache (DOM is already updated in step 4)
    console.log('🔄 RENUMBERING: Updating lazy loader cache from IndexedDB');
    const { currentLazyLoader } = await import('../initializePage.js');
    if (currentLazyLoader) {
      // Just update the in-memory nodeChunks array - DOM elements already updated in step 4
      currentLazyLoader.nodeChunks = await getAllNodeChunksForBook(book);
      console.log('✅ RENUMBERING: Lazy loader cache updated with fresh data');
    } else {
      console.warn('⚠️ RENUMBERING: Could not update cache - currentLazyLoader not available');
    }

    // 9. Hide modal and continue
    console.log('🎉 RENUMBERING COMPLETE');
    hideRenumberModal();
    isRenumberingInProgress = false;
    renumberingPromise = null;

    return true;

  } catch (error) {
    console.error('❌ RENUMBERING FAILED:', error);
    // Show red error indicator
    showError();
    // Re-enable mutation observer even on failure
    window.renumberingInProgress = false;
    console.log('🔓 RENUMBERING: Mutation observer re-enabled (after error)');
    return false;
  }
}

/**
 * Detect if we need to renumber (decimals getting too deep)
 * Only trigger renumbering when decimals exceed MAX_DECIMAL_DEPTH
 */
function needsRenumbering(beforeId, afterId) {
  const MAX_DECIMAL_DEPTH = 3; // Allow up to 3 decimal places (e.g., 1.123)

  if (!beforeId || !afterId) return false;

  const beforeNum = parseFloat(beforeId);
  const afterNum = parseFloat(afterId);

  if (isNaN(beforeNum) || isNaN(afterNum)) return false;

  // Check current decimal depth
  const beforeDecimal = beforeId.toString().split('.')[1] || '';
  const afterDecimal = afterId.toString().split('.')[1] || '';
  const currentMaxDepth = Math.max(beforeDecimal.length, afterDecimal.length);

  // If we're already at max depth, trigger renumbering
  if (currentMaxDepth >= MAX_DECIMAL_DEPTH) {
    console.log(`🔍 RENUMBER TRIGGER: Decimal depth ${currentMaxDepth} >= ${MAX_DECIMAL_DEPTH}`);
    return true;
  }

  // Allow normal decimal generation if under the limit
  return false;
}

// Utility: Generate a fallback unique ID if needed (used as a last resort).

export function compareDecimalStrings(a, b) {
  console.log(`Comparing decimal strings: "${a}" vs "${b}"`);
  
  // Handle null/undefined cases
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  
  // Convert to strings if they aren't already
  const aStr = a.toString();
  const bStr = b.toString();
  
  // Split into integer and decimal parts
  const [aInt, aDec = ""] = aStr.split(".");
  const [bInt, bDec = ""] = bStr.split(".");
  
  console.log(`Split results: a(${aInt}.${aDec}) vs b(${bInt}.${bDec})`);
  
  // Compare integer parts numerically
  const aIntNum = parseInt(aInt);
  const bIntNum = parseInt(bInt);
  
  if (aIntNum !== bIntNum) {
    const result = aIntNum - bIntNum;
    console.log(`Integer parts differ: ${aIntNum} vs ${bIntNum}, result: ${result}`);
    return result; // -1 if a < b, 1 if a > b, 0 if equal
  }
  
  console.log(`Integer parts equal (${aIntNum}), comparing decimal parts`);
  
  // Integer parts are equal, compare decimal parts as strings
  // Pad the shorter decimal with zeros for proper comparison
  const maxLen = Math.max(aDec.length, bDec.length);
  const aPadded = aDec.padEnd(maxLen, '0');
  const bPadded = bDec.padEnd(maxLen, '0');
  
  console.log(`Padded decimals: "${aPadded}" vs "${bPadded}"`);
  
  const result = aPadded.localeCompare(bPadded);
  console.log(`Decimal comparison result: ${result}`);
  
  return result;
}


/**
 * Set both id and data-node-id on an element
 * This ensures new elements can be tracked through renumbering
 */
export function setElementIds(element, beforeId, afterId, bookId) {
  // Generate and set the numerical ID
  element.id = generateIdBetween(beforeId, afterId);

  // Generate and set the permanent node_id if it doesn't exist
  if (!element.getAttribute('data-node-id')) {
    element.setAttribute('data-node-id', generateNodeId(bookId));
  }

  return element.id;
}

export function generateIdBetween(beforeId, afterId) {
  console.log("Generating ID between:", { beforeId, afterId });

  // RENUMBERING CHECK: Don't trigger here - let caller handle it after element is saved
  // Store the flag so caller can trigger renumbering deterministically
  const shouldRenumber = needsRenumbering(beforeId, afterId);
  if (shouldRenumber) {
    console.log('🔄 RENUMBERING NEEDED - Will trigger after element is saved');
  }

  // Store renumbering flag on window for caller to check
  window.__pendingRenumbering = shouldRenumber;

  // 1) No beforeId → just pick something before afterId
  if (!beforeId) {
    console.log("EXIT: No beforeId");
    if (!afterId) return "1";
    const afterNum = parseFloat(afterId);
    return isNaN(afterNum)
      ? "1"
      : Math.max(1, Math.floor(afterNum) - 1).toString();
  }

  // 2) No afterId → increment with 100-unit gap
  if (!afterId) {
    console.log("EXIT: No afterId");
    const beforeNum = parseFloat(beforeId);
    if (isNaN(beforeNum)) return `${beforeId}_1`;

    // Use 100-unit gaps to maintain renumbering pattern
    const beforeFloor = Math.floor(beforeNum);
    const nextInteger = beforeFloor + 100;

    // isDuplicateId check is kept as per your original code
    if (isDuplicateId(nextInteger.toString())) {
      console.warn(
        `Next integer ${nextInteger} already exists, falling back to decimal`
      );
      const [intPart, decPart = ""] = beforeId.split(".");
      if (Number.isInteger(beforeNum)) {
        return `${beforeNum}.1`;
      }
      if (decPart.endsWith("9")) {
        return `${intPart}.${decPart}1`;
      }
      const last = parseInt(decPart.slice(-1), 10);
      return `${intPart}.${decPart.slice(0, -1)}${last + 1}`;
    }

    console.log(`EXIT: No afterId, using 100-gap: ${nextInteger}`);
    return nextInteger.toString();
  }

  // 3) Both beforeId and afterId exist
  const beforeNum = parseFloat(beforeId);
  const afterNum = parseFloat(afterId);
  const cmp = compareDecimalStrings(beforeId, afterId);
  console.log("Comparison result:", cmp);

  if (cmp >= 0) {
    console.warn(`IDs out of order: ${beforeId} ≥ ${afterId}`);
    return generateIdBetween(beforeId, null);
  }

  if (!isNaN(beforeNum) && !isNaN(afterNum)) {
    // handle outrageously long decimals by simple string logic…
    const beforeDecLen = beforeId.split(".")[1]?.length || 0;
    const afterDecLen = afterId.split(".")[1]?.length || 0;
    if (beforeDecLen > 10 || afterDecLen > 10) {
      console.warn("Very long decimal detected, using string‐only logic");
      const [i, d = ""] = beforeId.split(".");
      if (d.endsWith("9")) return `${i}.${d}1`;
      if (d) {
        const last = parseInt(d.slice(-1), 10);
        return `${i}.${d.slice(0, -1)}${last + 1}`;
      }
      return `${i}.1`;
    }

    // ✨ NEW: Check for integer gap >= 2, use midpoint
    if (Number.isInteger(beforeNum) && Number.isInteger(afterNum)) {
      const gap = afterNum - beforeNum;
      if (gap >= 2) {
        const midpoint = Math.floor((beforeNum + afterNum) / 2);
        console.log(`EXIT: Integer gap ${gap}, using midpoint: ${midpoint}`);
        return midpoint.toString();
      }
    }

    // ✨ Check for integer gap when one is decimal
    // If there's room for an integer between them, use it
    const nextIntAfterBefore = Math.floor(beforeNum) + 1;
    if (compareDecimalStrings(nextIntAfterBefore.toString(), afterId) < 0) {
      console.log(`EXIT: Using next available integer: ${nextIntAfterBefore}`);
      return nextIntAfterBefore.toString();
    }

    const beforeParts = beforeId.split(".");
    const afterParts = afterId.split(".");
    const gap = afterNum - beforeNum;
    const lenB = beforeParts[1]?.length || 0;
    const lenA = afterParts[1]?.length || 0;

    // CASE 1) same integer part, both have decimals
    if (beforeParts[0] === afterParts[0] && lenB > 0 && lenA > 0) {
      console.log("Case 1: same int & both decimals");
      const intPart = beforeParts[0];
      const beforeDec = beforeParts[1];
      const afterDec = afterParts[1];

      // Pad both to the LONGER length to compare properly
      // 1.18 and 1.2 → treat as 1.18 vs 1.20
      const workingLength = Math.max(lenB, lenA);
      const paddedBeforeDec = beforeDec.padEnd(workingLength, "0");
      const paddedAfterDec = afterDec.padEnd(workingLength, "0");
      const beforeDecNum = parseInt(paddedBeforeDec, 10);
      const afterDecNum = parseInt(paddedAfterDec, 10);

      if (afterDecNum - beforeDecNum > 1) {
        // Room to increment: 1.18 and 1.2 → 1.19
        let newDec = (beforeDecNum + 1).toString().padStart(workingLength, "0");
        console.log(`EXIT: Room to increment decimal: ${intPart}.${newDec}`);
        return `${intPart}.${newDec}`;
      }

      // No room to increment, need to append a digit
      // 1.18 and 1.19 → 1.181
      console.log("EXIT: No room to increment, appending digit");
      return `${beforeId}1`;
    }

    // CASE 2: before is integer, after has decimals (e.g. 100 vs 100.1)
    console.log("Checking case 2:", {
      beforePartsLength: beforeParts.length,
      afterPartsLength: afterParts.length,
      sameIntegerPart: beforeParts[0] === afterParts[0],
    });
    if (
      beforeParts.length === 1 &&
      afterParts.length === 2 &&
      beforeParts[0] === afterParts[0]
    ) {
      // ... (This logic is correct for its purpose and is now protected by the fix above)
      console.log("EXIT: Case 2 triggered");
      const suffix = "0".repeat(lenA) + "1";
      return `${beforeParts[0]}.${suffix}`;
    }

    // CASE 3: integers with gap (e.g. 1 and 2 → 1.1, or 3 and 5 → 4)
    console.log("Checking case 3...");
    if (Number.isInteger(beforeNum) && Number.isInteger(afterNum)) {
      // ... (The fix above already handles the "3 and 5 -> 4" case, but this is fine as a fallback)
      if (afterNum - beforeNum === 1) {
        return `${beforeNum}.1`;
      } else if (afterNum - beforeNum > 1) {
        return (beforeNum + 1).toString();
      }
    }

    // CASE 4: before has decimal, after is integer
    if (!Number.isInteger(beforeNum) && Number.isInteger(afterNum)) {
      // ... (The fix above already handles the "3.5 and 5 -> 4" case)
      const beforeInt = Math.floor(beforeNum);
      if (afterNum - beforeInt > 1) {
        return (beforeInt + 1).toString();
      } else {
        const [i, d = ""] = beforeId.split(".");
        if (d.endsWith("9")) return `${i}.${d}1`;
        const last = parseInt(d.slice(-1), 10);
        return `${i}.${d.slice(0, -1)}${last + 1}`;
      }
    }
  }

  // FINAL fallback: This should now be unreachable for valid numerical inputs.
  console.log("EXIT: Fallback");
  return `${beforeId}_next`;
}
// Helper function to find the ID of the previous element with a numerical ID
export function findPreviousElementId(node) {
  let prev = node.previousElementSibling;
  while (prev) {
    if (prev.id && /^\d+(\.\d+)?$/.test(prev.id)) {
      return prev.id;
    }
    prev = prev.previousElementSibling;
  }
  return null;
}

// Helper function to find the ID of the next element with a numerical ID
export function findNextElementId(node) {
  let next = node.nextElementSibling;
  while (next) {
    if (next.id && /^\d+(\.\d+)?$/.test(next.id)) {
      return next.id;
    }
    next = next.nextElementSibling;
  }
  return null;
}

// Check if an id is numerical (integer or decimal)
export function isNumericalId(id) {
  // Remove any whitespace and check if it's a valid number
  const trimmedId = id.trim();
  return !isNaN(trimmedId) && !isNaN(parseFloat(trimmedId)) && trimmedId !== '';
}




export function generateUniqueId() {
  const id = "node_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
  console.log(`🆔 generateUniqueId: Created fallback ID: ${id}`);
  return id;
}

// Generate a unique node_id for persistent identification across renumbering
export function generateNodeId(bookId) {
  const id = `${bookId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  return id;
}

// Utility: Check if an id is duplicate within the document.
export function isDuplicateId(id) {
  const elements = document.querySelectorAll(`#${CSS.escape(id)}`);
  const isDuplicate = elements.length > 1;
  if (isDuplicate) {
    console.warn(`🚨 isDuplicateId: Found duplicate ID: ${id} (${elements.length} instances)`);
    // Log the elements with this ID to help debugging
    elements.forEach((el, i) => {
      console.warn(`  Duplicate #${i+1}: <${el.tagName.toLowerCase()}> with content: "${el.textContent.substring(0, 30)}..."`);
    });
  }
  return isDuplicate;
}

// New helper for generating an ID when inserting a new node with decimal logic.
export function generateInsertedNodeId(referenceNode, insertAfter = true) {
  console.log(`🔄 generateInsertedNodeId: Called with reference node:`, 
    referenceNode ? `#${referenceNode.id} <${referenceNode.tagName.toLowerCase()}>` : 'null', 
    `insertAfter: ${insertAfter}`);
  
  if (!referenceNode || !referenceNode.id) {
    console.warn(`⚠️ generateInsertedNodeId: No valid reference node, falling back to unique ID`);
    return generateUniqueId();
  }
  
  // Extract the numeric base from the reference node id.
  const baseMatch = referenceNode.id.match(/^(\d+)/);
  if (!baseMatch) {
    console.warn(`⚠️ generateInsertedNodeId: Reference node ID "${referenceNode.id}" doesn't match expected pattern, falling back to unique ID`);
    return generateUniqueId();
  }
  
  const baseId = baseMatch[1];
  let newId;
  
  if (insertAfter) {
    newId = getNextDecimalForBase(baseId);
    console.log(`✅ generateInsertedNodeId: Inserting AFTER #${referenceNode.id} → new ID: ${newId}`);
  } else {
    // For inserting before, try to derive from the previous sibling.
    const parent = referenceNode.parentElement;
    if (!parent) {
      console.warn(`⚠️ generateInsertedNodeId: Reference node has no parent, falling back to unique ID`);
      return generateUniqueId();
    }
    
    const siblings = Array.from(parent.children);
    const pos = siblings.indexOf(referenceNode);
    console.log(`🔍 generateInsertedNodeId: Reference node position among siblings: ${pos}/${siblings.length}`);
    
    if (pos > 0) {
      const prevSibling = siblings[pos - 1];
      if (prevSibling.id) {
        const prevMatch = prevSibling.id.match(/^(\d+)/);
        if (prevMatch) {
          const prevBase = prevMatch[1];
          newId = getNextDecimalForBase(prevBase);
          console.log(`✅ generateInsertedNodeId: Using previous sibling #${prevSibling.id} → new ID: ${newId}`);
        } else {
          newId = `${baseId}.1`;
          console.log(`⚠️ generateInsertedNodeId: Previous sibling has non-standard ID, using ${newId}`);
        }
      } else {
        newId = `${baseId}.1`;
        console.log(`⚠️ generateInsertedNodeId: Previous sibling has no ID, using ${newId}`);
      }
    } else {
      newId = `${baseId}.1`;
      console.log(`✅ generateInsertedNodeId: No previous sibling, using ${newId}`);
    }
  }
  
  return newId;
}



export function getNextDecimalForBase(base) {
  // Get all elements with this base in the current chunk
  const chunk = document.querySelector('.chunk');
  if (!chunk) return `${base}.1`;
  
  const baseElements = Array.from(chunk.querySelectorAll(`[id^="${base}."], [id="${base}"]`));
  
  // If no elements with this base exist, start with .1
  if (baseElements.length === 0) return `${base}.1`;
  
  // Sort by DOM order (visual order)
  baseElements.sort((a, b) => {
    const position = a.compareDocumentPosition(b);
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  
  // Find the last element in DOM order
  const lastElement = baseElements[baseElements.length - 1];
  
  // If the last element is the base itself (no decimal), use .1
  if (lastElement.id === base) return `${base}.1`;
  
  // Otherwise, increment the last decimal
  const match = lastElement.id.match(/^(\d+)\.(\d+)$/);
  if (match) {
    const lastSuffix = parseInt(match[2], 10);
    return `${base}.${lastSuffix + 1}`;
  }
  
  // Fallback
  return `${base}.1`;
}

export function getNextIntegerId(id) {
  const n = Math.floor(parseFloat(id));
  return String(n + 1);
}





// Replace original ensureNodeHasValidId with enhanced version using decimal logic.
export function ensureNodeHasValidId(node, options = {}) {
  const { referenceNode, insertAfter } = options;
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  // 🆕 NEW: Skip elements that shouldn't have IDs
  const skipElements = ['BR', 'SPAN', 'EM', 'STRONG', 'I', 'B', 'U', 'SUP', 'SUB', 'A', 'IMG'];
  if (skipElements.includes(node.tagName)) {
    console.log(`Skipping ID assignment for ${node.tagName} element`);
    return;
  }
  
  if (window.__enterKeyInfo && Date.now() - window.__enterKeyInfo.timestamp < 500) {
    const { nodeId, cursorPosition } = window.__enterKeyInfo;
    const referenceNode = document.getElementById(nodeId);
    if (referenceNode) {
      if (cursorPosition === "start") {
        const parent = referenceNode.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          const refIndex = siblings.indexOf(referenceNode);
          if (refIndex > 0) {
            const nodeAbove = siblings[refIndex - 1];
            if (nodeAbove.id) {
              const baseMatch = nodeAbove.id.match(/^(\d+)/);
              if (baseMatch) {
                const baseId = baseMatch[1];
                node.id = getNextDecimalForBase(baseId);
                console.log(`Cursor at start: New node gets ID ${node.id} based on node above (${nodeAbove.id})`);
                window.__enterKeyInfo = null;
                return;
              }
            }
          } else {
            const baseMatch = referenceNode.id.match(/^(\d+)/);
            if (baseMatch) {
              const baseId = parseInt(baseMatch[1], 10);
              const newBaseId = Math.max(1, baseId - 1).toString();
              node.id = newBaseId;
              console.log(`No node above; new node gets ID ${node.id} (one less than reference ${referenceNode.id})`);
              window.__enterKeyInfo = null;
              return;
            }
          }
        }
      } else {
        const baseMatch = referenceNode.id.match(/^(\d+)/);
        if (baseMatch) {
          const baseId = baseMatch[1];
          node.id = getNextDecimalForBase(baseId);
          console.log(`Cursor at ${cursorPosition}: New node gets ${node.id}, reference node stays ${referenceNode.id}`);
          window.__enterKeyInfo = null;
          return;
        }
      }
    }
    window.__enterKeyInfo = null;
  }

  
  // If node already has an id, check for duplicates:
  if (node.id) {
    if (isDuplicateId(node.id)) {
      const match = node.id.match(/^(\d+)(\.\d+)?$/);
      if (match) {
        const baseId = match[1];
        const newId = getNextDecimalForBase(baseId);
        console.log(`ID conflict detected. Changing node id from ${node.id} to ${newId}`);
        node.id = newId;
      } else {
        const oldId = node.id;
        node.id = generateUniqueId();
        console.log(`ID conflict detected (non-numeric). Changing node id from ${oldId} to ${node.id}`);
      }
    }
  } else {
    // NEW: Determine proper numerical ID based on position
    if (referenceNode && typeof insertAfter === "boolean") {
      node.id = generateInsertedNodeId(referenceNode, insertAfter);

      // ✅ Also set data-node-id if not present
      if (!node.getAttribute('data-node-id')) {
        node.setAttribute('data-node-id', generateNodeId(book));
      }

      console.log(`Assigned new id ${node.id} and data-node-id based on reference insertion direction.`);
    } else {
      // Find the node's position in the DOM and assign appropriate ID
      const beforeId = findPreviousElementId(node);
      const afterId = findNextElementId(node);

      node.id = generateIdBetween(beforeId, afterId);

      // ✅ Also set data-node-id if not present (same as setElementIds does)
      if (!node.getAttribute('data-node-id')) {
        node.setAttribute('data-node-id', generateNodeId(book));
      }

      console.log(`Assigned positional id ${node.id} and data-node-id to node <${node.tagName.toLowerCase()}> (between ${beforeId} and ${afterId})`);
    }
  }

}

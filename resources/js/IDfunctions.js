import { updateIndexedDBRecordForNormalization } from "./cache-indexedDB.js";// Utility: Generate a fallback unique ID if needed (used as a last resort).

export function generateUniqueId() {
  const id = "node_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
  console.log(`🆔 generateUniqueId: Created fallback ID: ${id}`);
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



export function generateIdBetween(beforeId, afterId) {
  console.log("Generating ID between:", { beforeId, afterId });

  // If no beforeId, use "1" or something just before afterId
  if (!beforeId) {
    if (!afterId) return "1";
    const afterNum = parseFloat(afterId);
    return isNaN(afterNum)
      ? "1"
      : Math.max(1, Math.floor(afterNum) - 1).toString();
  }

  // If no afterId, increment the beforeId
  if (!afterId) {
    const beforeNum = parseFloat(beforeId);
    if (isNaN(beforeNum)) return `${beforeId}_1`;
    if (Number.isInteger(beforeNum)) {
      return `${beforeNum}.1`;
    }
    const [intPart, decPart = ""] = beforeId.split(".");
    if (decPart.endsWith("9")) {
      return `${intPart}.${decPart}1`;
    } else {
      const last = parseInt(decPart.slice(-1), 10);
      return `${intPart}.${decPart.slice(0, -1)}${last + 1}`;
    }
  }

  // Both beforeId and afterId exist
  const beforeNum = parseFloat(beforeId);
  const afterNum = parseFloat(afterId);
  if (!isNaN(beforeNum) && !isNaN(afterNum)) {
    if (beforeNum >= afterNum) {
      console.warn(`IDs out of order: ${beforeId} ≥ ${afterId}`);
      return generateIdBetween(beforeId, null);
    }

    const beforeParts = beforeId.split(".");
    const afterParts = afterId.split(".");
    const gap = afterNum - beforeNum;
    const lenB = beforeParts[1]?.length || 0;
    const lenA = afterParts[1]?.length || 0;

    // 1) Same integer part, both have decimals
    if (beforeParts[0] === afterParts[0] && lenB > 0 && lenA > 0) {
      // Case A: same decimal length
      if (lenA === lenB && gap > 0 && gap <= 0.1) {
        return `${beforeId}1`;
      }
      // Case B+: afterId has more decimals
      if (lenA > lenB && gap > 0 && gap <= 0.1) {
        const extra = lenA - lenB;
        const suffix = "0".repeat(extra) + "1";
        return `${beforeId}${suffix}`;
      }
    }

    // 2) before is integer, after has decimal (e.g. 100 vs 100.1)
    if (
      beforeParts.length === 1 &&
      afterParts.length === 2 &&
      beforeParts[0] === afterParts[0] &&
      gap > 0 &&
      gap <= 0.1
    ) {
      // put "0...01" after the dot
      const suffix = "0".repeat(lenA) + "1"; 
      return `${beforeParts[0]}.${suffix}`;
    }

    // 3) consecutive integers (1 and 2)
    if (
      Number.isInteger(beforeNum) &&
      Number.isInteger(afterNum) &&
      afterNum - beforeNum === 1
    ) {
      return `${beforeNum}.1`;
    }

    // 4) before has decimal, after is whole
    if (!Number.isInteger(beforeNum) && Number.isInteger(afterNum)) {
      const beforeInt = Math.floor(beforeNum);
      if (afterNum - beforeInt <= 1) {
        return generateIdBetween(beforeId, null);
      } else {
        return (beforeInt + 1).toString();
      }
    }

    // Fallback: increment beforeId
    return generateIdBetween(beforeId, null);
  }

  // Default fallback
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







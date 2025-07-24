import { updateIndexedDBRecordForNormalization } from "./cache-indexedDB.js";// Utility: Generate a fallback unique ID if needed (used as a last resort).

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


export function generateIdBetween(beforeId, afterId) {
  console.log("Generating ID between:", { beforeId, afterId });

  // 1) No beforeId → just pick something before afterId
  if (!beforeId) {
    console.log("EXIT: No beforeId");
    if (!afterId) return "1";
    const afterNum = parseFloat(afterId);
    return isNaN(afterNum)
      ? "1"
      : Math.max(1, Math.floor(afterNum) - 1).toString();
  }

  // 2) No afterId → increment or fallback to decimal
  if (!afterId) {
    console.log("EXIT: No afterId");
    const beforeNum = parseFloat(beforeId);
    if (isNaN(beforeNum)) return `${beforeId}_1`;

    const nextInteger = Math.floor(beforeNum) + 1;
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

    // ✨ --- START OF THE FIX --- ✨
    // This new block handles the missing case by checking for an integer gap first.
    // It solves "1" vs "2.01" -> "2" and "3.5" vs "5" -> "4".
    const nextIntAfterBefore = Math.floor(beforeNum) + 1;
    if (compareDecimalStrings(nextIntAfterBefore.toString(), afterId) < 0) {
      console.log(`EXIT: Using next available integer: ${nextIntAfterBefore}`);
      return nextIntAfterBefore.toString();
    }
    // ✨ ---  END OF THE FIX  --- ✨

    const beforeParts = beforeId.split(".");
    const afterParts = afterId.split(".");
    const gap = afterNum - beforeNum;
    const lenB = beforeParts[1]?.length || 0;
    const lenA = afterParts[1]?.length || 0;

    // CASE 1) same integer part, both have decimals
    if (beforeParts[0] === afterParts[0] && lenB > 0 && lenA > 0) {
      // ... (This logic is correct for its purpose and is now protected by the fix above)
      console.log("Case 1: same int & both decimals");
      const intPart = beforeParts[0];
      const beforeDec = beforeParts[1];
      const afterDec = afterParts[1];
      if (lenA === lenB) return `${beforeId}1`;
      if (lenA > lenB) return `${beforeId}${"0".repeat(lenA - lenB)}1`;
      const paddedAfterDec = afterDec.padEnd(lenB, "0");
      const beforeNumDec = parseInt(beforeDec, 10);
      const afterNumDec = parseInt(paddedAfterDec, 10);
      if (afterNumDec - beforeNumDec > 1) {
        let newDec = (beforeNumDec + 1).toString().padStart(lenB, "0");
        return `${intPart}.${newDec}`;
      }
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
  const skipElements = ['BR', 'SPAN', 'EM', 'STRONG', 'I', 'B', 'U', 'SUP', 'SUB'];
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
      console.log(`Assigned new id ${node.id} based on reference insertion direction.`);
    } else {
      // Find the node's position in the DOM and assign appropriate ID
      const beforeId = findPreviousElementId(node);
      const afterId = findNextElementId(node);
      
      node.id = generateIdBetween(beforeId, afterId);
      console.log(`Assigned positional id ${node.id} to node <${node.tagName.toLowerCase()}> (between ${beforeId} and ${afterId})`);
    }
  }
  
}

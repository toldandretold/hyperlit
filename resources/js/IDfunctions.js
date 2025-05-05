import { updateIndexedDBRecordForNormalization } from "./cache-indexedDB.js";

// Utility: Generate a fallback unique ID if needed (used as a last resort).
export function generateUniqueId() {
  return (
    "node_" +
    Date.now() +
    "_" +
    Math.random().toString(36).substr(2, 5)
  );
}

// Utility: Check if an id is duplicate within the document.
export function isDuplicateId(id) {
  const elements = document.querySelectorAll(`#${CSS.escape(id)}`);
  return elements.length > 1;
}


// ----------------------------------------------------------------
// New helper for generating an ID when inserting a new node with decimal logic.
// This replaces the previous letter‐based suffix. For a reference node with id "17",
// inserting after will yield "17.1".
export function generateInsertedNodeId(referenceNode, insertAfter = true) {
  if (!referenceNode || !referenceNode.id) {
    return generateUniqueId();
  }
  // Extract the numeric base from the reference node id.
  const baseMatch = referenceNode.id.match(/^(\d+)/);
  if (!baseMatch) {
    return generateUniqueId();
  }
  const baseId = baseMatch[1];
  if (insertAfter) {
    return getNextDecimalForBase(baseId);
  } else {
    // For inserting before, try to derive from the previous sibling.
    const parent = referenceNode.parentElement;
    if (!parent) return generateUniqueId();
    const siblings = Array.from(parent.children);
    const pos = siblings.indexOf(referenceNode);
    if (pos > 0) {
      const prevSibling = siblings[pos - 1];
      if (prevSibling.id) {
        const prevMatch = prevSibling.id.match(/^(\d+)/);
        if (prevMatch) {
          const prevBase = prevMatch[1];
          return getNextDecimalForBase(prevBase);
        }
      }
    }
    return `${baseId}.1`;
  }
}

// ----------------------------------------------------------------
// Normalization function to ensure IDs are in ascending order 
// using decimal increments for nodes sharing the same base.
export async function normalizeNodeIds(container) {
  console.log("Starting node ID normalization...");

  // Filter nodes where id is a number with an optional decimal.
  const nodes = Array.from(container.querySelectorAll("[id]")).filter(
    (el) => /^(\d+)(\.\d+)?$/.test(el.id)
  );

  // Sort nodes by their interaction order in the DOM.
  nodes.sort((a, b) => {
    const position = a.compareDocumentPosition(b);
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  // Check if normalization is needed by comparing sorted order.
  let needsNormalization = false;
  for (let i = 0; i < nodes.length - 1; i++) {
    const currentId = parseFloat(nodes[i].id);
    const nextId = parseFloat(nodes[i + 1].id);
    // If the current numeric value is greater than the next,
    // something is off.
    if (currentId > nextId) {
      needsNormalization = true;
      console.log(
        `Found out-of-order IDs: ${nodes[i].id} comes before ${nodes[i + 1].id} in DOM`
      );
      break;
    }
  }

  if (!needsNormalization) {
    console.log("IDs are already in correct order, skipping normalization");
    return false;
  }

  // Group nodes by numeric base (the integer part)
  const baseGroups = {};
  nodes.forEach((node) => {
    const match = node.id.match(/^(\d+)/);
    if (match) {
      const base = match[1];
      if (!baseGroups[base]) {
        baseGroups[base] = [];
      }
      baseGroups[base].push(node);
    }
  });

  // Build a mapping from old ids to new ids.
  // For each group, we assign the first node the id equal to base,
  // and then subsequent nodes get base.1, base.2, etc.
  const idMap = {};
  Object.keys(baseGroups).forEach((base) => {
    const group = baseGroups[base];
    // You may choose to sort the group again by DOM position if needed.
    group.forEach((node, index) => {
      // By default, the first node remains as the base.
      // Subsequent nodes get a new id with decimal increments.
      const newId = index === 0 ? base : `${base}.${index}`;
      if (node.id !== newId) {
        idMap[node.id] = newId;
      }
    });
  });

  // Now apply the new IDs and update IndexedDB.
  let changesCount = 0;
  const changes = [];
  for (const [oldId, newId] of Object.entries(idMap)) {
    // Look up the node from the old id.
    const node = document.getElementById(oldId);
    if (node && oldId !== newId) {
      changes.push({ node, oldId, newId });
    }
  }

  for (const { node, oldId, newId } of changes) {
    console.log(`Normalizing: Changing node ID from ${oldId} to ${newId}`);
    node.id = newId;
    changesCount++;
    await updateIndexedDBRecordForNormalization(oldId, newId, node.outerHTML);
  }

  console.log(
    `Normalized node IDs in container. Made ${changesCount} changes.`
  );
  return changesCount > 0;
}


// ----------------------------------------------------------------
// New helper: Given a numeric base (as a string), find the next available decimal suffix.
// For example:
//    If there is no node with an ID "17.x", return "17.1".
//    If nodes with IDs "17.1" and "17.2" exist, return "17.3" (formatted with one decimal).
// New helper: Given a numeric base (as a string), return the next available ID
// as a number with one decimal place. It will scan all elements whose ID, when parsed
// as a float, is between base and base+1. For example, if "17" exists (i.e. 17.0)
// and the highest duplicate is 17.2, it returns "17.3".
export function getNextDecimalForBase(baseId) {
  const baseNumber = parseFloat(baseId);
  if (isNaN(baseNumber)) return baseId; // fallback

  const allNodes = Array.from(document.querySelectorAll("[id]"));

  // Start with the base number (i.e. 17.0) and look for duplicates in the range [17, 18)
  let maxVal = baseNumber; // if only "17" exists, think of it as 17.0
  for (const node of allNodes) {
    const parsed = parseFloat(node.id);
    // only consider IDs that parse as numbers in the range [baseNumber, baseNumber+1)
    if (!isNaN(parsed) && parsed >= baseNumber && parsed < baseNumber + 1) {
      if (parsed > maxVal) {
        maxVal = parsed;
      }
    }
  }
  // Increment by 0.1 using one decimal precision
  const nextVal = (maxVal + 0.1).toFixed(1);
  return nextVal;
}



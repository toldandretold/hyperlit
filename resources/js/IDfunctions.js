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


// Normalization function with enhanced logging
export async function normalizeNodeIds(container) {
  console.log(`🔄 normalizeNodeIds: Starting normalization for container:`, 
    container ? `#${container.id || 'no-id'} <${container.tagName.toLowerCase()}>` : 'null');

  if (!container) {
    console.warn(`⚠️ normalizeNodeIds: No container provided, aborting`);
    return false;
  }

  // Filter nodes where id is a number with an optional decimal.
  const nodes = Array.from(container.querySelectorAll("[id]")).filter(
    (el) => /^(\d+)(\.\d+)?$/.test(el.id)
  );

  console.log(`🔍 normalizeNodeIds: Found ${nodes.length} nodes with numeric IDs`);
  
  if (nodes.length === 0) {
    console.log(`ℹ️ normalizeNodeIds: No numeric IDs to normalize`);
    return false;
  }

  // Sort nodes by their interaction order in the DOM.
  nodes.sort((a, b) => {
    const position = a.compareDocumentPosition(b);
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  console.log(`🔍 normalizeNodeIds: Nodes sorted by DOM position:`, 
    nodes.map(n => `#${n.id} <${n.tagName.toLowerCase()}>`).join(', '));

  // Check if normalization is needed by comparing sorted order.
  let needsNormalization = false;
  for (let i = 0; i < nodes.length - 1; i++) {
    const currentId = parseFloat(nodes[i].id);
    const nextId = parseFloat(nodes[i + 1].id);
    // If the current numeric value is greater than the next, something is off.
    if (currentId > nextId) {
      needsNormalization = true;
      console.warn(`🚨 normalizeNodeIds: Found out-of-order IDs: ${nodes[i].id} comes before ${nodes[i + 1].id} in DOM`);
      break;
    }
  }

  if (!needsNormalization) {
    console.log(`✅ normalizeNodeIds: IDs are already in correct order, skipping normalization`);
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

  console.log(`🔍 normalizeNodeIds: Grouped nodes by base:`, 
    Object.keys(baseGroups).map(base => `Base ${base}: ${baseGroups[base].length} nodes`).join(', '));

  // Build a mapping from old ids to new ids.
  const idMap = {};
  Object.keys(baseGroups).forEach((base) => {
    const group = baseGroups[base];
    console.log(`🔍 normalizeNodeIds: Processing base group ${base} with ${group.length} nodes`);
    
    group.forEach((node, index) => {
      const newId = index === 0 ? base : `${base}.${index}`;
      if (node.id !== newId) {
        idMap[node.id] = newId;
        console.log(`🔄 normalizeNodeIds: Will change #${node.id} to #${newId}`);
      } else {
        console.log(`✅ normalizeNodeIds: Node #${node.id} already has correct ID`);
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

  console.log(`🔄 normalizeNodeIds: About to apply ${changes.length} ID changes`);

  for (const { node, oldId, newId } of changes) {
    console.log(`🔄 normalizeNodeIds: Changing node ID from ${oldId} to ${newId}`);
    node.id = newId;
    changesCount++;
    await updateIndexedDBRecordForNormalization(oldId, newId, node.outerHTML);
  }

  console.log(`✅ normalizeNodeIds: Completed with ${changesCount} changes`);
  return changesCount > 0;
}

// Add logging to generateIntermediateId
export function generateIntermediateId(container, beforeElement, afterElement) {
  console.log(`🔄 generateIntermediateId: Called with:`, 
    `container: #${container?.id || 'no-id'}`,
    `beforeElement: ${beforeElement ? `#${beforeElement.id || 'no-id'}` : 'null'}`,
    `afterElement: ${afterElement ? `#${afterElement.id || 'no-id'}` : 'null'}`);
  
  // If no before element, use a base ID one less than the after element
  if (!beforeElement && afterElement && afterElement.id) {
    const afterMatch = afterElement.id.match(/^(\d+)(?:\.(\d+))?$/);
    if (afterMatch) {
      const afterBase = parseInt(afterMatch[1], 10);
      const afterSuffix = afterMatch[2] ? parseInt(afterMatch[2], 10) : 0;
      
      let newId;
      if (afterSuffix > 0) {
        // If after element has a suffix, use same base with smaller suffix
        newId = `${afterBase}.${Math.max(1, Math.floor(afterSuffix / 2))}`;
        console.log(`✅ generateIntermediateId: No before element, after has suffix → ${newId}`);
      } else if (afterBase > 1) {
        // If after element has no suffix but base > 1, use previous base
        newId = `${afterBase - 1}`;
        console.log(`✅ generateIntermediateId: No before element, after has base > 1 → ${newId}`);
      } else {
        // If after element is base 1 with no suffix, use 1.1
        newId = "1.1";
        console.log(`✅ generateIntermediateId: No before element, after is base 1 → ${newId}`);
      }
      return newId;
    }
  }
  
  // If no after element, use a base ID one more than the before element
  if (beforeElement && beforeElement.id && !afterElement) {
    const beforeMatch = beforeElement.id.match(/^(\d+)(?:\.(\d+))?$/);
    if (beforeMatch) {
      const beforeBase = parseInt(beforeMatch[1], 10);
      const beforeSuffix = beforeMatch[2] ? parseInt(beforeMatch[2], 10) : 0;
      
      let newId;
      if (beforeSuffix > 0) {
        // If before element has a suffix, use same base with larger suffix
        newId = `${beforeBase}.${beforeSuffix + 1}`;
        console.log(`✅ generateIntermediateId: No after element, before has suffix → ${newId}`);
      } else {
        // If before element has no suffix, add .1
        newId = `${beforeBase}.1`;
        console.log(`✅ generateIntermediateId: No after element, before has no suffix → ${newId}`);
      }
      return newId;
    }
  }
  
  // If we have both before and after elements
  if (beforeElement && beforeElement.id && afterElement && afterElement.id) {
    const beforeMatch = beforeElement.id.match(/^(\d+)(?:\.(\d+))?$/);
    const afterMatch = afterElement.id.match(/^(\d+)(?:\.(\d+))?$/);
    
    if (beforeMatch && afterMatch) {
      const beforeBase = parseInt(beforeMatch[1], 10);
      const beforeSuffix = beforeMatch[2] ? parseInt(beforeMatch[2], 10) : 0;
      const afterBase = parseInt(afterMatch[1], 10);
      const afterSuffix = afterMatch[2] ? parseInt(afterMatch[2], 10) : 0;
      
      let newId;
      // If they have the same base
      if (beforeBase === afterBase) {
        // Calculate a suffix between the two
        if (afterSuffix - beforeSuffix > 1) {
          // If there's room between suffixes, use the middle
          newId = `${beforeBase}.${Math.floor((beforeSuffix + afterSuffix) / 2)}`;
          console.log(`✅ generateIntermediateId: Same base, gap between suffixes → ${newId}`);
        } else {
          // If they're consecutive, add a digit
          newId = `${beforeBase}.${beforeSuffix}5`;
          console.log(`✅ generateIntermediateId: Same base, consecutive suffixes → ${newId}`);
        }
      } else if (afterBase - beforeBase > 1) {
        // If bases are different with gap, use the middle base
        newId = `${Math.floor((beforeBase + afterBase) / 2)}`;
        console.log(`✅ generateIntermediateId: Different bases with gap → ${newId}`);
      } else {
        // If bases are consecutive, use the first base with a suffix
        newId = `${beforeBase}.${beforeSuffix > 0 ? beforeSuffix + 1 : 1}`;
        console.log(`✅ generateIntermediateId: Consecutive bases → ${newId}`);
      }
      return newId;
    }
  }
  
  // Fallback: generate a unique ID
  console.warn(`⚠️ generateIntermediateId: Could not determine intermediate ID, falling back to unique ID`);
  return generateUniqueId();
}



// Function to generate a new ID between two existing IDs
export function generateIdBetween(beforeId, afterId) {
  // If no afterId, just increment the beforeId
  if (!afterId) {
    const match = beforeId.match(/^(\d+)(?:\.(\d+))?$/);
    if (!match) return "node_" + Date.now();
    
    const base = match[1];
    const suffix = match[2] ? parseInt(match[2], 10) : 0;
    return suffix === 0 ? `${base}.1` : `${base}.${suffix + 1}`;
  }
  
  // If no beforeId, use something before afterId
  if (!beforeId) {
    const match = afterId.match(/^(\d+)(?:\.(\d+))?$/);
    if (!match) return "node_" + Date.now();
    
    const base = match[1];
    const suffix = match[2] ? parseInt(match[2], 10) : 0;
    return suffix > 1 ? `${base}.${suffix - 1}` : base;
  }
  
  // Parse both IDs
  const beforeMatch = beforeId.match(/^(\d+)(?:\.(\d+))?$/);
  const afterMatch = afterId.match(/^(\d+)(?:\.(\d+))?$/);
  
  // If either doesn't match the pattern, use fallback
  if (!beforeMatch || !afterMatch) return "node_" + Date.now();
  
  const beforeBase = beforeMatch[1];
  const afterBase = afterMatch[1];
  
  // If bases don't match, just increment the beforeId
  if (beforeBase !== afterBase) {
    const suffix = beforeMatch[2] ? parseInt(beforeMatch[2], 10) : 0;
    return suffix === 0 ? `${beforeBase}.1` : `${beforeBase}.${suffix + 1}`;
  }
  
  const beforeSuffix = beforeMatch[2] ? parseInt(beforeMatch[2], 10) : 0;
  const afterSuffix = afterMatch[2] ? parseInt(afterMatch[2], 10) : 0;
  
  // If there's room between the suffixes, use the middle
  if (afterSuffix - beforeSuffix > 1) {
    return `${beforeBase}.${Math.floor((beforeSuffix + afterSuffix) / 2)}`;
  }
  
  // Otherwise, use a decimal
  return `${beforeBase}.${beforeSuffix}5`;
}

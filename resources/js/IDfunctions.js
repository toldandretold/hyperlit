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

// Function to get the next decimal ID for a base
export function getNextDecimalForBase(base, referenceElement = null, insertAfter = true) {
  console.log(`🔢 getNextDecimalForBase: Called with base "${base}", referenceElement:`, 
    referenceElement ? `#${referenceElement.id}` : 'null', 
    `insertAfter: ${insertAfter}`);
  
  // IMPORTANT: Find the current node's position in the DOM
  if (window.__enterKeyInfo && Date.now() - window.__enterKeyInfo.timestamp < 500) {
    const { nodeId } = window.__enterKeyInfo;
    const referenceNode = document.getElementById(nodeId);
    
    if (referenceNode) {
      console.log(`🔍 getNextDecimalForBase: Using Enter key reference node #${nodeId}`);
      
      // Get the parent container
      const container = referenceNode.parentElement;
      if (container) {
        // Get all siblings with numeric IDs
        const siblings = Array.from(container.children).filter(el => 
          el.id && /^\d+(\.\d+)?$/.test(el.id)
        );
        
        // Sort siblings by DOM order
        const domOrderedSiblings = siblings.slice().sort((a, b) => {
          const position = a.compareDocumentPosition(b);
          return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });
        
        console.log(`🔍 getNextDecimalForBase: DOM-ordered siblings:`, 
          domOrderedSiblings.map(s => s.id).join(', '));
        
        // Find the reference node's position
        const refIndex = domOrderedSiblings.indexOf(referenceNode);
        
        if (refIndex !== -1) {
          // For Enter at end, we want to insert AFTER the reference node
          // Get the next node in DOM order (if any)
          if (refIndex < domOrderedSiblings.length - 1) {
            const nextNode = domOrderedSiblings[refIndex + 1];
            console.log(`🔍 getNextDecimalForBase: Next node in DOM is #${nextNode.id}`);
            
            // Parse the IDs as floats for comparison
            const refId = parseFloat(referenceNode.id);
            const nextId = parseFloat(nextNode.id);
            
            // Generate an ID between the reference and next node
            if (nextId > refId) {
              // Simple case: next ID is already higher
              const newId = `${base}.${Math.floor((refId * 10 + nextId * 10) / 20)}`;
              console.log(`✅ getNextDecimalForBase: Generated ID between ${referenceNode.id} and ${nextNode.id}: ${newId}`);
              return newId;
            }
          }
          
          // If we're at the end or next node has lower ID, just increment
          const baseMatch = referenceNode.id.match(/^(\d+)(?:\.(\d+))?$/);
          if (baseMatch) {
            const refBase = parseInt(baseMatch[1], 10);
            const refSuffix = baseMatch[2] ? parseInt(baseMatch[2], 10) : 0;
            
            if (refBase.toString() === base) {
              const newId = `${base}.${refSuffix + 1}`;
              console.log(`✅ getNextDecimalForBase: Incrementing from reference: ${newId}`);
              return newId;
            }
          }
        }
      }
    }
  }
  
  // If we have a reference element and know where we're inserting
  if (referenceElement && referenceElement.id && referenceElement.id.startsWith(base + '.')) {
    // Your existing code for reference element...
  }
  
  // IMPORTANT CHANGE: Consider DOM order when finding the next available ID
  console.log(`🔍 getNextDecimalForBase: Using DOM-aware method to find next ID for base "${base}"`);
  
  // Get the current chunk
  const chunk = document.querySelector('.chunk');
  if (chunk) {
    // Get all elements with this base in the chunk
    const baseElements = Array.from(chunk.querySelectorAll(`[id^="${base}."]`));
    
    // Sort by DOM order
    baseElements.sort((a, b) => {
      const position = a.compareDocumentPosition(b);
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    
    console.log(`🔍 getNextDecimalForBase: Found ${baseElements.length} elements with base ${base} in DOM order:`, 
      baseElements.map(el => el.id).join(', '));
    
    // If we have the Enter key info, find where to insert
    if (window.__enterKeyInfo && Date.now() - window.__enterKeyInfo.timestamp < 500) {
      const { nodeId, cursorPosition } = window.__enterKeyInfo;
      const referenceNode = document.getElementById(nodeId);
      
      if (referenceNode) {
        const refIndex = baseElements.indexOf(referenceNode);
        
        if (refIndex !== -1) {
          // If cursor at end, insert after this node
          if (cursorPosition === "end") {
            if (refIndex < baseElements.length - 1) {
              // There's a node after this one
              const nextNode = baseElements[refIndex + 1];
              const refId = parseFloat(referenceNode.id);
              const nextId = parseFloat(nextNode.id);
              
              // Generate ID between them
              const newId = `${base}.${Math.floor((refId * 10 + nextId * 10) / 20)}`;
              console.log(`✅ getNextDecimalForBase: Generated ID between ${referenceNode.id} and ${nextNode.id}: ${newId}`);
              return newId;
            } else {
              // This is the last node with this base
              const match = referenceNode.id.match(/^(\d+)\.(\d+)$/);
              if (match) {
                const suffix = parseInt(match[2], 10);
                const newId = `${base}.${suffix + 1}`;
                console.log(`✅ getNextDecimalForBase: Last node, incrementing suffix: ${newId}`);
                return newId;
              }
            }
          }
          // If cursor at start, insert before this node
          else if (cursorPosition === "start") {
            if (refIndex > 0) {
              // There's a node before this one
              const prevNode = baseElements[refIndex - 1];
              const prevId = parseFloat(prevNode.id);
              const refId = parseFloat(referenceNode.id);
              
              // Generate ID between them
              const newId = `${base}.${Math.floor((prevId * 10 + refId * 10) / 20)}`;
              console.log(`✅ getNextDecimalForBase: Generated ID between ${prevNode.id} and ${referenceNode.id}: ${newId}`);
              return newId;
            } else {
              // This is the first node with this base
              const match = referenceNode.id.match(/^(\d+)\.(\d+)$/);
              if (match) {
                const suffix = parseInt(match[2], 10);
                const newId = suffix > 1 ? `${base}.${Math.floor(suffix/2)}` : `${base}.1`;
                console.log(`✅ getNextDecimalForBase: First node, creating lower suffix: ${newId}`);
                return newId;
              }
            }
          }
        }
      }
    }
  }
  
  // Fallback to the original method if we can't determine context
  console.log(`🔍 getNextDecimalForBase: Using fallback method to find next available suffix for base "${base}"`);
  
  // IMPORTANT: Sort the IDs numerically, not just find the max
  const re = new RegExp(`^${base}\\.(\\d+)$`);
  const suffixes = [];
  
  document.querySelectorAll("[id]").forEach(el => {
    const m = el.id.match(re);
    if (m) {
      const suffix = parseInt(m[1], 10);
      suffixes.push(suffix);
    }
  });
  
  // Sort suffixes numerically
  suffixes.sort((a, b) => a - b);
  
  // Find the first gap or add to the end
  let newSuffix = 1;
  for (let i = 0; i < suffixes.length; i++) {
    if (suffixes[i] !== i + 1) {
      newSuffix = i + 1;
      break;
    }
    newSuffix = i + 2; // One more than the last suffix
  }
  
  const newId = `${base}.${newSuffix}`;
  console.log(`✅ getNextDecimalForBase: Generated new ID using gaps or end: ${newId}`);
  return newId;
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

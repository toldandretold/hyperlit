import { updateIndexedDBRecord } from './cache-indexedDB.js';

// Object to store node counts for each chunk
export const chunkNodeCounts = {};

// Define the node limit constant
export const NODE_LIMIT = 100;

/**
 * Count nodes in a chunk and track changes
 * @param {HTMLElement} chunk - The chunk element to count nodes in
 * @param {MutationRecord[]} mutations - Optional mutations to process
 */
export function trackChunkNodeCount(chunk, mutations = null) {
  console.log("trackChunkNodeCount started");
  if (!chunk) return;
  
  const chunkId = chunk.getAttribute('data-chunk-id');
  if (!chunkId) {
    console.warn('Chunk missing data-chunk-id attribute');
    return;
  }
  
  // Initialize count if this is the first time seeing this chunk
  if (chunkNodeCounts[chunkId] === undefined) {
    // Count all nodes with IDs that match our numeric pattern
    const nodeCount = chunk.querySelectorAll('[id^="0"], [id^="1"], [id^="2"], [id^="3"], [id^="4"], [id^="5"], [id^="6"], [id^="7"], [id^="8"], [id^="9"]').length;
    chunkNodeCounts[chunkId] = nodeCount;
    console.log(`Initial count for chunk: ${chunkId} = ${nodeCount}`);
    return;
  }
  
  // If mutations provided, update the count based on additions/removals
  if (mutations) {
    let addedCount = 0;
    let removedCount = 0;
    
    mutations.forEach(mutation => {
      if (mutation.type === 'childList') {
        // Count added nodes that have numeric IDs
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.id && /^\d+(\.\d+)?$/.test(node.id)) {
              addedCount++;
            }
            // Also count any child elements with numeric IDs
            if (node.querySelectorAll) {
              addedCount += node.querySelectorAll('[id^="0"], [id^="1"], [id^="2"], [id^="3"], [id^="4"], [id^="5"], [id^="6"], [id^="7"], [id^="8"], [id^="9"]').length;
            }
          }
        });
        
        // Count removed nodes that have numeric IDs
        mutation.removedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.id && /^\d+(\.\d+)?$/.test(node.id)) {
              removedCount++;
            }
            // Also count any child elements with numeric IDs
            if (node.querySelectorAll) {
              removedCount += node.querySelectorAll('[id^="0"], [id^="1"], [id^="2"], [id^="3"], [id^="4"], [id^="5"], [id^="6"], [id^="7"], [id^="8"], [id^="9"]').length;
            }
          }
        });
      }
    });
    
    // Update the count
    if (addedCount > 0 || removedCount > 0) {
      const oldCount = chunkNodeCounts[chunkId];
      chunkNodeCounts[chunkId] = oldCount + addedCount - removedCount;
      console.log(`Count for chunk: ${chunkId} = ${chunkNodeCounts[chunkId]} (added: ${addedCount}, removed: ${removedCount})`);
    }
  }
}

/**
 * Get the next chunk after the current one
 * @param {HTMLElement} currentChunk - The current chunk
 * @returns {HTMLElement|null} - The next chunk or null if none exists
 */
export function getNextChunk(currentChunk) {
  // Find all chunks in the document
  const allChunks = document.querySelectorAll('[data-chunk-id]');
  const chunks = Array.from(allChunks);
  
  // Find the index of the current chunk
  const currentIndex = chunks.indexOf(currentChunk);
  
  // Return the next chunk if it exists
  if (currentIndex >= 0 && currentIndex < chunks.length - 1) {
    return chunks[currentIndex + 1];
  }
  
  return null;
}

/**
 * Create a new chunk after the specified chunk
 * @param {HTMLElement} afterChunk - The chunk to insert after
 * @returns {HTMLElement} - The newly created chunk
 */
export function createNewChunk(afterChunk) {
  // Find all chunks in the document
  const existingChunks = document.querySelectorAll('[data-chunk-id]');
  
  // Extract numeric chunk IDs
  const chunkIds = Array.from(existingChunks).map(chunk => {
    const id = chunk.getAttribute('data-chunk-id');
    // Handle both formats: "chunk-1" and "1"
    return parseInt(id.includes('chunk-') ? id.replace('chunk-', '') : id, 10);
  }).filter(id => !isNaN(id)); // Filter out any NaN values
  
  // Find the next available chunk ID
  const maxId = chunkIds.length > 0 ? Math.max(...chunkIds) : -1;
  const newChunkId = String(maxId + 1); // Just use the number as a string
  
  // Create the new chunk element
  const newChunk = document.createElement('div');
  newChunk.setAttribute('data-chunk-id', newChunkId);
  newChunk.className = 'chunk';
  
  // Insert after the specified chunk
  if (afterChunk.nextSibling) {
    afterChunk.parentNode.insertBefore(newChunk, afterChunk.nextSibling);
  } else {
    afterChunk.parentNode.appendChild(newChunk);
  }
  
  // Initialize the node count for this chunk
  chunkNodeCounts[newChunkId] = 0;
  
  console.log(`Created new chunk with ID: ${newChunkId}`);
  return newChunk;
}


/**
 * Handle overflow when a chunk reaches the node limit
 * @param {HTMLElement} currentChunk - The current chunk that's full
 * @param {MutationRecord[]} mutations - The mutations that triggered the overflow
 */

export async function handleChunkOverflow(currentChunk, mutations) {
  // Get the current chunk ID
  const currentChunkId = currentChunk.getAttribute('data-chunk-id');
  
  // Get all nodes in the current chunk with numeric IDs
  const allNodesInChunk = Array.from(currentChunk.querySelectorAll('[id]')).filter(node => 
    /^\d+(\.\d+)?$/.test(node.id)
  );
  
  // Sort nodes by their ID numerically to ensure we're moving the last nodes
  allNodesInChunk.sort((a, b) => {
    const idA = parseFloat(a.id);
    const idB = parseFloat(b.id);
    return idA - idB;
  });
  
  // If we don't have enough nodes to overflow, exit early
  if (allNodesInChunk.length <= NODE_LIMIT) {
    return;
  }
  
  // Determine which nodes need to be moved (always the last ones)
  const nodesToKeep = allNodesInChunk.slice(0, NODE_LIMIT);
  const overflowNodes = allNodesInChunk.slice(NODE_LIMIT);
  
  console.log(`Chunk ${currentChunkId} has ${allNodesInChunk.length} nodes. Moving ${overflowNodes.length} nodes to a new chunk.`);
  
  if (overflowNodes.length === 0) return;
  
  // Store the IDs and HTML of nodes that will be moved
  const overflowNodeData = overflowNodes.map(node => ({
    id: node.id,
    html: node.outerHTML
  }));
  
  // Find the first and last overflow node
  const firstOverflowNode = overflowNodes[0];
  const lastOverflowNode = overflowNodes[overflowNodes.length - 1];
  
  // Generate new chunk ID
  const newChunkId = generateNextChunkId(currentChunkId);
  
  // Create a new chunk by splitting the DOM at the right position
  const newChunk = document.createElement('div');
  newChunk.className = 'chunk';
  newChunk.setAttribute('data-chunk-id', newChunkId);
  
  // Use Range to extract the overflow nodes and place them in the new chunk
  const range = document.createRange();
  range.setStartBefore(firstOverflowNode);
  range.setEndAfter(lastOverflowNode);
  
  // Insert the new chunk after the current chunk
  currentChunk.parentNode.insertBefore(newChunk, currentChunk.nextSibling);
  
  // Move the range contents into the new chunk
  newChunk.appendChild(range.extractContents());
  
  // Wait a short time to allow the mutation observer to process the removals
  // and delete the nodes from IndexedDB
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Now re-create the nodes in IndexedDB with the new chunk_id
  const savePromises = [];
  
  overflowNodeData.forEach(({ id, html }) => {
    // Find the node in its new location to get the current HTML
    const movedNode = newChunk.querySelector(`#${CSS.escape(id)}`);
    const currentHtml = movedNode ? movedNode.outerHTML : html;
    
    console.log(`Re-creating node ${id} in IndexedDB with chunk_id ${newChunkId}`);
    
    // Create a new record in IndexedDB with the new chunk_id
    savePromises.push(
      updateIndexedDBRecord({
        id: id,
        html: currentHtml,
        chunk_id: parseFloat(newChunkId),
        action: "add" // Use "add" instead of "update" to create a new record
      }).catch(error => console.error(`Error creating node ${id}:`, error))
    );
  });
  
  // Update node counts for both chunks
  chunkNodeCounts[currentChunkId] = NODE_LIMIT;
  chunkNodeCounts[newChunkId] = overflowNodeData.length;
  
  // Wait for all saves to complete
  await Promise.all(savePromises);
  console.log(`Re-created ${overflowNodeData.length} nodes in new chunk ${newChunkId}`);
}



// Add this helper function if you don't already have it
function generateNextChunkId(currentId) {
  // If the current ID is numeric, increment it
  if (/^\d+$/.test(currentId)) {
    return String(parseInt(currentId) + 1);
  }
  // If it's a decimal format like "1.1", increment the decimal part
  else if (/^\d+\.\d+$/.test(currentId)) {
    const parts = currentId.split('.');
    return `${parts[0]}.${parseInt(parts[1]) + 1}`;
  }
  // Fallback: just append ".1" to the current ID
  else {
    return `${currentId}.1`;
  }
}


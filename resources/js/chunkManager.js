import { updateIndexedDBRecord } from './indexedDB.js';
import { generateIdBetween } from './utilities/IDfunctions.js';
import { setChunkOverflowInProgress, currentObservedChunk } from './utilities/operationState.js';
import { startObserving, stopObserving, movedNodesByOverflow } from './divEditor/index.js';

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
 * Handle overflow when a chunk reaches the node limit
 * @param {HTMLElement} currentChunk - The current chunk that's full
 * @param {MutationRecord[]} mutations - The mutations that triggered the overflow
 */

export async function handleChunkOverflow(currentChunk, mutations) {
  // Set flag at the beginning
  setChunkOverflowInProgress(true);

  try {
    // IMPORTANT: Capture the active node and selection BEFORE any changes
    const selection = document.getSelection();
    let activeNode = null;
    let selectionOffset = 0;
    
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      let node = range.startContainer;
      selectionOffset = range.startOffset;
      
      // Get the relevant element node
      if (node.nodeType !== Node.ELEMENT_NODE) {
        activeNode = node.parentElement;
      } else {
        activeNode = node;
      }
      
      // Find the closest parent with an ID
      while (activeNode && !activeNode.id) {
        activeNode = activeNode.parentElement;
      }
    }
    
    const activeNodeId = activeNode?.id;
    const activeNodeIsInCurrentChunk = activeNode && currentChunk.contains(activeNode);
    
    // NEW: Also find the next sibling node - this would be the target of the next Enter press
    let nextSiblingNode = null;
    if (activeNode) {
      nextSiblingNode = activeNode.nextElementSibling;
    }
    const nextSiblingId = nextSiblingNode?.id;
    
    console.log("Active node before overflow:", activeNodeId, 
                "Next sibling node:", nextSiblingId,
                "In current chunk:", activeNodeIsInCurrentChunk);
  
  
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

    // Check if the active node is among the nodes being moved
    const activeNodeWillMove = activeNodeId && overflowNodes.some(node => node.id === activeNodeId);
    const nextSiblingWillMove = nextSiblingId && overflowNodes.some(node => node.id === nextSiblingId);
    
    console.log("Active node will move:", activeNodeWillMove, 
                "Next sibling will move:", nextSiblingWillMove);
    
    // Find the first and last overflow node
    const firstOverflowNode = overflowNodes[0];
    const lastOverflowNode = overflowNodes[overflowNodes.length - 1];
    
    // Check if there's a next chunk and if it has room
    const nextChunk = currentChunk.nextElementSibling;
    const nextChunkIsChunk = nextChunk && nextChunk.classList.contains('chunk');
    
    let targetChunk;
    let newChunkId;
    
    
    if (nextChunkIsChunk) {
      // Get the next chunk ID
      const nextChunkId = nextChunk.getAttribute('data-chunk-id');
      
      // Check if the next chunk has room using our tracking system
      const nextChunkNodeCount = chunkNodeCounts[nextChunkId] || 0;
      
      // If the next chunk has room, use it instead of creating a new one
      if (nextChunkNodeCount + overflowNodes.length <= NODE_LIMIT) {
        console.log(`Using existing chunk ${nextChunkId} for overflow nodes (current count: ${nextChunkNodeCount})`);
        targetChunk = nextChunk;
        newChunkId = nextChunkId;
        
        // Move the next chunk div to be positioned right after the current chunk's kept nodes
        const range = document.createRange();
        range.setStartBefore(firstOverflowNode);
        range.setEndAfter(lastOverflowNode);
        
        // Extract the overflow nodes
        const overflowFragment = range.extractContents();
        
        // Insert the next chunk div before the first overflow node's original position
        currentChunk.parentNode.insertBefore(targetChunk, currentChunk.nextSibling);
        
        // Insert the overflow nodes at the beginning of the next chunk
        if (targetChunk.firstChild) {
          targetChunk.insertBefore(overflowFragment, targetChunk.firstChild);
        } else {
          targetChunk.appendChild(overflowFragment);
        }
      } else {
        // Next chunk doesn't have room, create a new one
        targetChunk = document.createElement('div');
        targetChunk.className = 'chunk';
        // Use generateIdBetween to create an ID between current and next chunks
        newChunkId = generateIdBetween(currentChunkId, nextChunkId);
        targetChunk.setAttribute('data-chunk-id', newChunkId);
        
        // Use Range to extract the overflow nodes and place them in the new chunk
        const range = document.createRange();
        range.setStartBefore(firstOverflowNode);
        range.setEndAfter(lastOverflowNode);
        
        // Insert the new chunk after the current chunk but before the next chunk
        currentChunk.parentNode.insertBefore(targetChunk, nextChunk);
        
        // Move the range contents into the new chunk
        targetChunk.appendChild(range.extractContents());
      }
    } else {
      // No next chunk, create a new one
      targetChunk = document.createElement('div');
      targetChunk.className = 'chunk';
      
      // Parse the current chunk ID
      const currentId = parseFloat(currentChunkId);
      
      // If it's a valid number, increment it appropriately
      if (!isNaN(currentId)) {
        if (Number.isInteger(currentId)) {
          // If it's a whole number, just add 1
          newChunkId = (currentId + 1).toString();
        } else {
          // If it has a decimal part, round up to the next integer
          newChunkId = Math.ceil(currentId).toString();
        }
      } else {
        // Fallback if ID isn't numeric
        newChunkId = generateIdBetween(currentChunkId, null);
      }
      
      targetChunk.setAttribute('data-chunk-id', newChunkId);
      
      // Use Range to extract the overflow nodes and place them in the new chunk
      const range = document.createRange();
      range.setStartBefore(firstOverflowNode);
      range.setEndAfter(lastOverflowNode);
      
      // Insert the new chunk after the current chunk
      currentChunk.parentNode.insertBefore(targetChunk, currentChunk.nextSibling);
      
      // Move the range contents into the new chunk
      targetChunk.appendChild(range.extractContents());
    }
  
    // Store the IDs and HTML of nodes that will be moved
    const overflowNodeData = overflowNodes.map(node => ({
      id: node.id,
      html: node.outerHTML
    }));
    
    // Wait a short time to allow the mutation observer to process the removals
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Now re-create the nodes in IndexedDB with the new chunk_id
    const savePromises = [];
    
    overflowNodeData.forEach(({ id, html }) => {
      // Find the node in its new location to get the current HTML
      const movedNode = targetChunk.querySelector(`#${CSS.escape(id)}`);
      const currentHtml = movedNode ? movedNode.outerHTML : html;
      
      // Create a new record in IndexedDB with the new chunk_id
      savePromises.push(
        updateIndexedDBRecord({
          id: id,
          html: currentHtml,
          chunk_id: parseFloat(newChunkId),
          action: "update" // Change to 'update' to ensure upsert behavior if ID exists
        }).catch(error => console.error(`Error updating node ${id}:`, error))
      );
    });
    
    // Update node counts for both chunks
    chunkNodeCounts[currentChunkId] = NODE_LIMIT;
    
    if (nextChunkIsChunk && targetChunk === nextChunk) {
      // If we used an existing chunk, add to its count
      chunkNodeCounts[newChunkId] += overflowNodes.length;
    } else {
      // If we created a new chunk, set its count
      chunkNodeCounts[newChunkId] = overflowNodes.length;
    }
    
    // Re-count nodes in both chunks to ensure accuracy
    trackChunkNodeCount(currentChunk);
    trackChunkNodeCount(targetChunk);
    
    // Wait for all saves to complete
    await Promise.all(savePromises);
    console.log(`Re-created ${overflowNodeData.length} nodes in chunk ${newChunkId}`);
    
    // *** ADD THIS SECTION ***
    // Mark these nodes as being handled by the overflow process
    overflowNodeData.forEach(({ id }) => {
      movedNodesByOverflow.add(id);
    });
    //console.log("Moved nodes added to movedNodesByOverflow set:", Array.from(movedNodesByOverflow));
    // IMPROVED CURSOR POSITIONING FOR ENTER KEY PRESSES:
    
    // First check: If this appears to be an Enter key press (looking for newly created empty paragraph)
    const isLikelyEnterPress = mutations && mutations.some(m => 
      m.addedNodes.length === 1 && 
      m.addedNodes[0].nodeName === 'P' && 
      (!m.addedNodes[0].textContent.trim() || m.addedNodes[0].innerHTML === '<br>')
    );
    
    if (isLikelyEnterPress && nextSiblingWillMove) {
      // This is likely an Enter key press and the next node was moved
      console.log("Enter key detected and next node moved - positioning cursor in next node");
      
      // Find the node in its new location
      const movedNextNode = document.getElementById(nextSiblingId);
      if (movedNextNode) {
        const newSelection = document.getSelection();
        const newRange = document.createRange();
        
        // Position at the beginning of the next node
        if (movedNextNode.firstChild && movedNextNode.firstChild.nodeType === Node.TEXT_NODE) {
          newRange.setStart(movedNextNode.firstChild, 0);
        } else {
          newRange.setStart(movedNextNode, 0);
        }
        
        newRange.collapse(true);
        newSelection.removeAllRanges();
        newSelection.addRange(newRange);
        
        // Ensure the node is visible
        movedNextNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        // Also update the observer to watch the new chunk
        if (currentObservedChunk !== targetChunk) {
          setChunkOverflowInProgress(true);
          stopObserving();
          startObserving(targetChunk);
          setChunkOverflowInProgress(false);
        }
      }
    } else if (activeNodeWillMove) {
      // Standard case: active node was moved
      console.log("Active node was moved - updating cursor position");
      
      // Find the active node in its new location
      const movedActiveNode = document.getElementById(activeNodeId);
      if (movedActiveNode) {
        const newSelection = document.getSelection();
        const newRange = document.createRange();
        
        // Try to position at the same location
        if (movedActiveNode.firstChild && movedActiveNode.firstChild.nodeType === Node.TEXT_NODE) {
          const maxOffset = movedActiveNode.firstChild.length;
          const offset = Math.min(selectionOffset, maxOffset);
          newRange.setStart(movedActiveNode.firstChild, offset);
        } else {
          newRange.setStart(movedActiveNode, 0);
        }
        
        newRange.collapse(true);
        newSelection.removeAllRanges();
        newSelection.addRange(newRange);
        
        // Ensure the node is visible
        movedActiveNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        // Also update the observer to watch the new chunk
        if (currentObservedChunk !== targetChunk) {
          stopObserving();
          startObserving(targetChunk);
        }
      }
    } else {
      // If nothing relevant moved, make sure we're still observing the right chunk
      if (currentObservedChunk !== targetChunk && (activeNodeWillMove || nextSiblingWillMove)) {
        stopObserving();
        startObserving(targetChunk);
      }
    }
    
    return true;
  } catch (error) {
    console.error("Error in handleChunkOverflow:", error);
    return false;
  } finally {
    // Always clear the flag when done, even if there was an error
    setChunkOverflowInProgress(false);
    // *** ADD THIS LINE TO CLEAR THE SET WHEN OVERFLOW IS COMPLETE ***
    movedNodesByOverflow.clear();
    console.log("Moved nodes set cleared.");
  }
}






export function getCurrentChunk() {
  const selection = document.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    let node = range.startContainer;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      node = node.parentElement;
    }
    const chunkElement = node.closest(".chunk");
    return chunkElement ? chunkElement.id || chunkElement.dataset.chunkId : null;
  }
  return null;
}
























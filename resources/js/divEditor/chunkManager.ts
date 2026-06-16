import { updateSingleIndexedDBRecord } from '../indexedDB/index';
import { generateIdBetween } from '../utilities/IDfunctions.js';
import { setChunkOverflowInProgress } from '../utilities/operationState.js';
import { verbose } from '../utilities/logger.js';
// ✅ Lazy-loaded: divEditor index only used during editing
// import { startObserving, stopObserving, movedNodesByOverflow } from './index';

// Object to store node counts for each chunk
export const chunkNodeCounts: Record<string, number> = {};

// Define the node limit constant
export const NODE_LIMIT = 100;

/**
 * Helper: Count numerical ID nodes efficiently
 */
function countNumericalNodes(container: HTMLElement): number {
  // 🚀 PERFORMANCE: Single query + filter is 3-5x faster than 9 separate queries
  const allNodes = container.querySelectorAll('[id]');
  let count = 0;
  const numericIdRegex = /^\d+(\.\d+)?$/;

  for (const node of allNodes) {
    if (numericIdRegex.test(node.id)) {
      count++;
    }
  }

  return count;
}

/**
 * Per-chunk NODE COUNTING — overflow detection.
 *
 * The edit-mode MutationObserver watches the whole editable CONTAINER (<main class="main-content">, or a
 * sub-book) with subtree:true — see startObserving() in divEditor/index.ts — so it already
 * sees every chunk at once. We do NOT observe mutations in one chunk at a time.
 *
 * This just maintains chunkNodeCounts[chunkId]: a running count of numeric-id nodes in each
 * chunk, updated FROM the container-wide observer's mutations, so we can tell when a chunk
 * crosses NODE_LIMIT (100) and must be split by handleChunkOverflow().
 */
export function trackChunkNodeCount(chunk: HTMLElement | null, mutations: MutationRecord[] | null = null): void {
  verbose.content('trackChunkNodeCount started', 'chunkManager.js');
  if (!chunk) return;

  const chunkId = chunk.getAttribute('data-chunk-id');
  if (!chunkId) {
    console.warn('Chunk missing data-chunk-id attribute');
    return;
  }

  // Initialize count if this is the first time seeing this chunk
  if (chunkNodeCounts[chunkId] === undefined) {
    // 🚀 PERFORMANCE: Use optimized counting function
    const nodeCount = countNumericalNodes(chunk);
    chunkNodeCounts[chunkId] = nodeCount;
    verbose.content(`Initial count for chunk: ${chunkId} = ${nodeCount}`, 'chunkManager.js');
    return;
  }

  // If mutations provided, recount when childList changes occurred
  // Direct DOM recount avoids delta drift that caused spurious overflow
  if (mutations) {
    const hasNodeChanges = mutations.some(m =>
      m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)
    );
    if (hasNodeChanges) {
      const newCount = countNumericalNodes(chunk);
      if (newCount !== chunkNodeCounts[chunkId]) {
        verbose.content(`Count for chunk: ${chunkId} = ${newCount} (was ${chunkNodeCounts[chunkId]})`, 'chunkManager.js');
        chunkNodeCounts[chunkId] = newCount;
      }
    }
  }
}




/**
 * Handle overflow when a chunk reaches the node limit
 */
export async function handleChunkOverflow(currentChunk: HTMLElement, mutations: MutationRecord[] | null): Promise<boolean | undefined> {
  // ✅ Dynamically import divEditor state (only used during editing)
  const { movedNodesByOverflow } = await import('./index');

  // Set flag at the beginning
  setChunkOverflowInProgress(true);

  // 🔒 Prevent user input during chunk move to avoid orphaned text nodes
  const mainContent = document.querySelector('.main-content');
  const wasEditable = mainContent?.getAttribute('contenteditable') === 'true';
  if (mainContent && wasEditable) {
    mainContent.setAttribute('contenteditable', 'false');
    console.log('🔒 Chunk overflow: Disabled contenteditable during node move');
  }

  try {
    // IMPORTANT: Capture the active node and selection BEFORE any changes
    const selection = document.getSelection();
    let activeNode: any = null;
    let selectionOffset = 0;

    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      let node: any = range.startContainer;
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

    const activeNodeId: string | undefined = activeNode?.id;
    const activeNodeIsInCurrentChunk = activeNode && currentChunk.contains(activeNode);

    // NEW: Also find the next sibling node - this would be the target of the next Enter press
    let nextSiblingNode: any = null;
    if (activeNode) {
      nextSiblingNode = activeNode.nextElementSibling;
    }
    const nextSiblingId: string | undefined = nextSiblingNode?.id;

    console.log("Active node before overflow:", activeNodeId,
                "Next sibling node:", nextSiblingId,
                "In current chunk:", activeNodeIsInCurrentChunk);


    // Get the current chunk ID
    const currentChunkId = currentChunk.getAttribute('data-chunk-id')!;

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

    // If we don't have enough nodes to overflow, reset the inflated count and exit
    if (allNodesInChunk.length <= NODE_LIMIT) {
      chunkNodeCounts[currentChunkId] = allNodesInChunk.length;
      return false;
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
    if (!firstOverflowNode || !lastOverflowNode) return false;

    // Check if there's a next chunk and if it has room
    const nextChunk = currentChunk.nextElementSibling;
    const nextChunkIsChunk = nextChunk && nextChunk.classList.contains('chunk');

    let targetChunk: any;
    let newChunkId: any;


    if (nextChunkIsChunk) {
      // Get the next chunk ID
      const nextChunkId = nextChunk!.getAttribute('data-chunk-id')!;

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
        currentChunk.parentNode!.insertBefore(targetChunk, currentChunk.nextSibling);

        // Insert the overflow nodes at the beginning of the next chunk
        if (targetChunk.firstChild) {
          targetChunk.insertBefore(overflowFragment, targetChunk.firstChild);
        } else {
          targetChunk.appendChild(overflowFragment);
        }

        // 🧹 Clean up any orphaned text nodes left behind after extractContents
        const parent = currentChunk.parentNode!;
        Array.from(parent.childNodes).forEach(node => {
          if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
            console.warn('🧹 Cleaning orphaned text node:', node.textContent);
            // Move orphaned text to the last paragraph in current chunk
            const lastP = currentChunk.querySelector('p:last-of-type');
            if (lastP) {
              lastP.appendChild(node.cloneNode(true));
            }
            node.remove();
          }
        });
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
        currentChunk.parentNode!.insertBefore(targetChunk, nextChunk);

        // Move the range contents into the new chunk
        targetChunk.appendChild(range.extractContents());

        // 🧹 Clean up any orphaned text nodes left behind after extractContents
        const parent = currentChunk.parentNode!;
        Array.from(parent.childNodes).forEach(node => {
          if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
            console.warn('🧹 Cleaning orphaned text node:', node.textContent);
            // Move orphaned text to the last paragraph in current chunk
            const lastP = currentChunk.querySelector('p:last-of-type');
            if (lastP) {
              lastP.appendChild(node.cloneNode(true));
            }
            node.remove();
          }
        });
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
      currentChunk.parentNode!.insertBefore(targetChunk, currentChunk.nextSibling);

      // Move the range contents into the new chunk
      targetChunk.appendChild(range.extractContents());

      // 🧹 Clean up any orphaned text nodes left behind after extractContents
      const parent = currentChunk.parentNode!;
      Array.from(parent.childNodes).forEach(node => {
        if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
          console.warn('🧹 Cleaning orphaned text node:', node.textContent);
          // Move orphaned text to the last paragraph in current chunk
          const lastP = currentChunk.querySelector('p:last-of-type');
          if (lastP) {
            lastP.appendChild(node.cloneNode(true));
          }
          node.remove();
        }
      });
    }

    // Store the IDs and HTML of nodes that will be moved
    const overflowNodeData = overflowNodes.map(node => ({
      id: node.id,
      html: node.outerHTML
    }));

    // Wait a short time to allow the mutation observer to process the removals
    await new Promise(resolve => setTimeout(resolve, 100));

    // Now re-create the nodes in IndexedDB with the new chunk_id
    const savePromises: Promise<any>[] = [];

    overflowNodeData.forEach(({ id, html }) => {
      // Find the node in its new location to get the current HTML
      const movedNode = targetChunk.querySelector(`#${CSS.escape(id)}`);
      const currentHtml = movedNode ? movedNode.outerHTML : html;

      // Create a new record in IndexedDB with the new chunk_id
      savePromises.push(
        updateSingleIndexedDBRecord({
          id: id,
          html: currentHtml,
          chunk_id: parseFloat(newChunkId),
          action: "update" // Change to 'update' to ensure upsert behavior if ID exists
        } as any).catch((error: any) => console.error(`Error updating node ${id}:`, error))
      );
    });

    // Update node counts for both chunks
    chunkNodeCounts[currentChunkId] = NODE_LIMIT;

    if (nextChunkIsChunk && targetChunk === nextChunk) {
      // If we used an existing chunk, add to its count
      chunkNodeCounts[newChunkId] = (chunkNodeCounts[newChunkId] as number) + overflowNodes.length;
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
      m.addedNodes[0]?.nodeName === 'P' &&
      (!m.addedNodes[0]?.textContent?.trim() || (m.addedNodes[0] as HTMLElement).innerHTML === '<br>')
    );

    if (isLikelyEnterPress && nextSiblingWillMove) {
      // This is likely an Enter key press and the next node was moved
      console.log("Enter key detected and next node moved - positioning cursor in next node");

      // Find the node in its new location
      const movedNextNode = document.getElementById(nextSiblingId!);
      if (movedNextNode) {
        const newSelection = document.getSelection()!;
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
      }
    } else if (activeNodeWillMove) {
      // Standard case: active node was moved
      console.log("Active node was moved - updating cursor position");

      // Find the active node in its new location
      const movedActiveNode = document.getElementById(activeNodeId!);
      if (movedActiveNode) {
        const newSelection = document.getSelection()!;
        const newRange = document.createRange();

        // Try to position at the same location
        if (movedActiveNode.firstChild && movedActiveNode.firstChild.nodeType === Node.TEXT_NODE) {
          const maxOffset = (movedActiveNode.firstChild as Text).length;
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
      }
    }
    // NOTE: the observer is rooted at the editable CONTAINER (main-content / sub-book)
    // with subtree:true, and the new chunk was inserted into that same container — so it
    // is already observed. No stop/start restart is needed here (an earlier restart that
    // re-pointed the observer at a single chunk silently dropped edits in other chunks).

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

    // 🔓 Re-enable contenteditable after chunk move completes
    if (mainContent && wasEditable) {
      mainContent.setAttribute('contenteditable', 'true');
      console.log('🔓 Chunk overflow: Re-enabled contenteditable after node move');
    }
  }
}


// Returns the id STRING of the `.chunk` the caret is currently in, or null when there's
// no selection / no enclosing chunk. Consumed as a string by setCurrentObservedChunk and
// the selectionchange focus tracker in divEditor/index.ts.
export function getCurrentChunk(): string | null {
  const selection = document.getSelection();
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const node: Node = range.startContainer;
    const el: Element | null =
      node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const chunkElement = el?.closest<HTMLElement>(".chunk");
    return chunkElement ? (chunkElement.id || chunkElement.dataset.chunkId || null) : null;
  }
  return null;
}

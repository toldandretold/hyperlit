/**
 * ChunkMutationHandler Module
 *
 * Handles mutations within .chunk elements (lazy-loaded document sections).
 * Filters, processes, and tracks changes to chunks including:
 * - Node additions/deletions/modifications
 * - SPAN tag destruction (browser formatting cleanup)
 * - Hypercite handling
 * - Chunk overflow management
 */

import { chunkOverflowInProgress } from "../utilities/operationState.js";
import { isNumericalId, ensureNodeHasValidId } from "../utilities/IDfunctions.js";
import { movedNodesByOverflow } from '../divEditor.js';
import { showSpinner, isProcessing } from '../components/editIndicator.js';
import { trackChunkNodeCount, NODE_LIMIT, chunkNodeCounts, handleChunkOverflow } from '../chunkManager.js';
import { checkAndInvalidateTocCache, invalidateTocCacheForDeletion } from '../components/toc.js';
import { deleteIndexedDBRecordWithRetry } from '../indexedDB.js';
import { isPasteOperationActive } from '../paste.js';

/**
 * ChunkMutationHandler class
 * Processes DOM mutations within document chunks
 */
export class ChunkMutationHandler {
  constructor(options = {}) {
    // Dependencies
    this.observedChunks = options.observedChunks || new Map();
    this.saveQueue = options.saveQueue;
    this.handleHyperciteRemoval = options.handleHyperciteRemoval;
    this.ensureMinimumStructure = options.ensureMinimumStructure;
    this.queueNodeForSave = options.queueNodeForSave;

    // Tracking sets
    this.removedNodeIds = options.removedNodeIds || new Set();
    this.addedNodes = options.addedNodes || new Set();
    this.modifiedNodes = options.modifiedNodes || new Set();

    // Document changed flag
    this.documentChanged = { value: false };
    if (options.documentChanged) {
      this.documentChanged = options.documentChanged;
    }
  }

  /**
   * Filter mutations to only include those within .chunk elements
   */
  filterChunkMutations(mutations) {
    const filteredMutations = [];

    mutations.forEach(mutation => {
      // Check if mutation target is within a chunk
      const chunk = this.findContainingChunk(mutation.target);

      if (chunk !== null) {
        if (mutation.type === 'childList') {
          const isOnlyHighlightNodes = (nodeList) => {
            if (nodeList.length === 0) return false;
            return Array.from(nodeList).every(
              (node) => node.nodeName === 'MARK' || node.nodeType === Node.TEXT_NODE
            );
          };

          // Ignore MARK tag mutations (handled by hyperlights module)
          if (isOnlyHighlightNodes(mutation.addedNodes) || isOnlyHighlightNodes(mutation.removedNodes)) {
            console.log("✍️ Ignoring MARK tag mutation in divEditor, handled by hyperlights module.");
            return;
          }
        }

        filteredMutations.push(mutation);
        return;
      }

      // Special case: Check for deletion of chunks
      if (mutation.type === 'childList' && mutation.removedNodes.length > 0) {
        const chunkDeletions = Array.from(mutation.removedNodes).filter(node =>
          node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('chunk')
        );

        if (chunkDeletions.length > 0) {
          if (chunkOverflowInProgress) {
            console.log(`⚠️ Skipping direct chunk deletion handling (DB) because chunk overflow is in progress.`);
          } else {
            console.log('Detected chunk deletion(s):', chunkDeletions);

            chunkDeletions.forEach(deletedChunk => {
              const numericalIdNodes = this.findNumericalIdNodesInChunk(deletedChunk);

              if (numericalIdNodes.length > 0) {
                console.log('Deleting numerical ID nodes from IndexedDB:', numericalIdNodes);
                numericalIdNodes.forEach(node => {
                  console.log(`Queueing node ${node.id} for batch deletion (chunk removal)`);
                  if (this.saveQueue) {
                    this.saveQueue.queueDeletion(node.id);
                  }
                });
              }
            });
          }

          filteredMutations.push(mutation);
        } else {
          // Check for other numerical ID deletions
          const hasNumericalIdDeletion = Array.from(mutation.removedNodes).some(node =>
            this.isNumericalIdDeletion(node, mutation.target)
          );

          if (hasNumericalIdDeletion) {
            filteredMutations.push(mutation);
          }
        }
      }
    });

    return filteredMutations;
  }

  /**
   * Check if mutations should be skipped (status icon mutations)
   */
  shouldSkipMutation(mutations) {
    return mutations.some(mutation =>
      mutation.target.id === "status-icon" ||
      (mutation.target.parentNode && mutation.target.parentNode.id === "status-icon") ||
      mutation.addedNodes.length && Array.from(mutation.addedNodes).some(node =>
        node.id === "status-icon" || (node.parentNode && node.parentNode.id === "status-icon")
      )
    );
  }

  /**
   * Process mutations grouped by their containing chunk
   */
  async processByChunk(mutations) {
    const mutationsByChunk = new Map();
    const newChunksFound = new Set();

    // Group mutations by chunk
    for (const mutation of mutations) {
      const chunk = this.findContainingChunk(mutation.target);

      if (chunk) {
        const chunkId = chunk.getAttribute('data-chunk-id');

        if (!chunkId) {
          console.warn("Found chunk without data-chunk-id:", chunk);
          continue;
        }

        // Handle new chunks being added via lazy loading
        if (!this.observedChunks.has(chunkId)) {
          this.handleNewChunk(chunk);
          newChunksFound.add(chunkId);
        }

        if (!mutationsByChunk.has(chunkId)) {
          mutationsByChunk.set(chunkId, []);
        }
        mutationsByChunk.get(chunkId).push(mutation);
      }
    }

    if (newChunksFound.size > 0) {
      console.log(`📦 Found ${newChunksFound.size} new chunks:`, Array.from(newChunksFound));
    }

    // Process mutations for each chunk
    for (const [chunkId, chunkMutations] of mutationsByChunk) {
      // Query for fresh chunk element to avoid stale references
      const liveChunk = document.querySelector(`[data-chunk-id="${chunkId}"]`);

      if (liveChunk) {
        this.observedChunks.set(chunkId, liveChunk);

        // Yield to main thread for snappier typing
        setTimeout(async () => {
          await this.processChunkMutations(liveChunk, chunkMutations);
        }, 0);
      } else if (!window.isEditing) {
        console.log(`🗑️ Chunk ${chunkId} actually removed from DOM`);

        setTimeout(() => {
          this.observedChunks.delete(chunkId);
          delete chunkNodeCounts[chunkId];
          console.log(`✅ Chunk ${chunkId} cleanup completed`);
        }, 300);
      }
    }
  }

  /**
   * Handle a new chunk being discovered
   */
  handleNewChunk(chunk) {
    const chunkId = chunk.getAttribute('data-chunk-id');

    if (!chunkId) {
      console.warn("Found chunk without data-chunk-id:", chunk);
      return;
    }

    console.log(`📦 New chunk loaded: ${chunkId}`);

    this.observedChunks.set(chunkId, chunk);
    trackChunkNodeCount(chunk);
  }

  /**
   * Process mutations for a specific chunk
   */
  async processChunkMutations(chunk, mutations) {
    const chunkId = chunk.getAttribute('data-chunk-id');

    console.log(`🔄 Processing ${mutations.length} mutations for chunk ${chunkId}`);

    // Skip during renumbering
    if (window.renumberingInProgress) {
      console.log(`⚠️ Skipping mutation processing for chunk ${chunkId} during renumbering`);
      return;
    }

    // Skip during chunk overflow
    if (chunkOverflowInProgress) {
      const isRemovalMutation = mutations.some(m => m.type === "childList" && m.removedNodes.length > 0);

      if (isRemovalMutation) {
        console.log(`⚠️ Skipping mutation processing for chunk ${chunkId} during chunk overflow (due to removal).`);
        return;
      }
    }

    // Show spinner if not already processing
    if (!isProcessing) {
      showSpinner();
    }

    // Track node count changes
    trackChunkNodeCount(chunk, mutations);

    const currentNodeCount = chunkNodeCounts[chunkId] || 0;

    // Handle chunk overflow
    if (currentNodeCount > NODE_LIMIT &&
        mutations.some(m => m.type === "childList" && m.addedNodes.length > 0)) {
      console.log(`Chunk ${chunkId} has reached limit (${currentNodeCount}/${NODE_LIMIT}). Managing overflow...`);
      await handleChunkOverflow(chunk, mutations);
      return;
    }

    // Track parent nodes that need updates
    const parentsToUpdate = new Set();
    let addedCount = 0;
    const newNodes = [];
    let pasteDetected = false;

    if (mutations.some(m => m.type === "childList" && m.addedNodes.length > 1)) {
      pasteDetected = true;
      console.log("Possible paste operation detected");
    }

    for (const mutation of mutations) {
      // Process removals
      if (mutation.type === "childList" && mutation.removedNodes.length > 0) {
        let shouldUpdateParent = false;
        let parentNode = null;

        for (const node of mutation.removedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Skip nodes moved by chunk overflow
            if (node.id && movedNodesByOverflow.has(node.id)) {
              console.log(`🗑️ Skipping deletion for node ${node.id} as it's handled by chunk overflow.`);
              movedNodesByOverflow.delete(node.id);
              continue;
            }

            // Check for hypercite removals
            if (this.handleHyperciteRemoval) {
              await this.handleHyperciteRemoval(node);
            }

            // Handle numerical ID deletions
            if (node.id && node.id.match(/^\d+(\\.\\d+)?$/)) {
              console.log(`🗑️ Attempting to delete node ${node.id} from IndexedDB`);

              invalidateTocCacheForDeletion(node.id);

              const remainingNodes = chunk.querySelectorAll('[id]').length;
              console.log(`🔍 [LAST NODE CHECK] Chunk ${chunkId} has ${remainingNodes} remaining nodes after deleting ${node.id}`);

              if (remainingNodes === 0) {
                console.log(`🚨 [LAST NODE] Last node ${node.id} being deleted from chunk ${chunkId}`);

                deleteIndexedDBRecordWithRetry(node.id).then(() => {
                  const pasteActive = isPasteOperationActive();
                  console.log(`🔍 [LAST NODE] After deletion, paste active: ${pasteActive}`);
                  if (!pasteActive && this.ensureMinimumStructure) {
                    console.log(`🔧 [LAST NODE] Calling ensureMinimumDocumentStructure()`);
                    this.ensureMinimumStructure();
                  } else {
                    console.log(`⏸️ [LAST NODE] Skipping structure check - paste in progress`);
                  }
                });

                return;
              } else {
                console.log(`🗑️ Queueing node ${node.id} for batch deletion`);
                if (this.saveQueue) {
                  this.saveQueue.queueDeletion(node.id);
                }
                this.removedNodeIds.add(node.id);
              }
            }
            // Handle hypercite deletions
            else if (node.id && node.id.startsWith("hypercite_")) {
              parentNode = mutation.target;
              shouldUpdateParent = true;
              console.log(`Hypercite removed from parent: ${parentNode.id}`, node);
            }
          }
        }

        // Handle parent updates
        if (shouldUpdateParent && parentNode) {
          let closestParent = parentNode;
          while (closestParent && (!closestParent.id || !closestParent.id.match(/^\d+(\\.\\d+)?$/))) {
            closestParent = closestParent.parentElement;
          }

          if (closestParent && closestParent.id) {
            parentsToUpdate.add(closestParent);
          }
        }
      }

      // Handle attribute mutations (SPAN styling)
      if (mutation.type === "attributes" && mutation.target.nodeType === Node.ELEMENT_NODE) {
        const element = mutation.target;

        if (element.tagName === 'SPAN' && mutation.attributeName === 'style') {
          console.log(`🔥 DESTROYING SPAN that gained style attribute`, element);

          const { replacementNode, cursorInfo } = this.destroySpan(element);

          continue;
        }
      }

      // Skip icon-only mutations
      if (mutation.type === "childList") {
        const allAreIcons = Array.from(mutation.addedNodes).every((n) => {
          if (n.nodeType !== Node.ELEMENT_NODE) return false;
          const el = n;
          if (el.classList.contains("open-icon")) return true;
          if (
            el.tagName === "A" &&
            el.children.length === 1 &&
            el.firstElementChild.classList.contains("open-icon")
          ) {
            return true;
          }
          return false;
        });

        if (allAreIcons) {
          continue;
        }
      }

      // Process added nodes
      if (mutation.type === "childList") {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {

            if (node.id && node.id.startsWith('hypercite_')) {
              console.log(`✍️ Ignoring standalone hypercite mutation for ${node.id}. It will be saved with its parent.`);
              return;
            }

            // Destroy SPAN tags
            if (node.tagName === 'SPAN') {
              console.log(`🔥 DESTROYING SPAN tag - NO SPANS ALLOWED`);
              this.destroySpan(node);
              return;
            }

            // Clean browser-generated inline styles
            if (['I', 'B', 'EM', 'STRONG'].includes(node.tagName) && node.style && node.style.length > 0) {
              const hasSuspiciousStyles = node.style.fontSize ||
                                        node.style.fontWeight ||
                                        node.style.letterSpacing ||
                                        node.style.wordSpacing;

              if (hasSuspiciousStyles) {
                console.log(`🔥 DESTROYING browser-generated ${node.tagName} with inline styles`);

                const cleanElement = document.createElement(node.tagName.toLowerCase());

                Array.from(node.attributes).forEach(attr => {
                  if (attr.name !== 'style') {
                    cleanElement.setAttribute(attr.name, attr.value);
                  }
                });

                cleanElement.textContent = node.textContent;

                node.parentNode.insertBefore(cleanElement, node);
                node.remove();
                return;
              }
            }

            ensureNodeHasValidId(node);
            this.documentChanged.value = true;
            this.addedNodes.add(node);
            addedCount++;
            newNodes.push(node);

            checkAndInvalidateTocCache(node.id, node);

            if (pasteDetected && node.id) {
              console.log(`Queueing potentially pasted node: ${node.id}`);
              if (this.queueNodeForSave) {
                this.queueNodeForSave(node.id, 'add');
              }
            }

            // Handle formatting elements
            if (['B', 'STRONG', 'I', 'EM', 'SPAN'].includes(node.tagName) && !node.id) {
              let parentWithId = node.parentElement;
              while (parentWithId && !parentWithId.id) {
                parentWithId = parentWithId.parentElement;
              }

              if (parentWithId && parentWithId.id) {
                console.log(`Queueing parent ${parentWithId.id} due to formatting change (${node.tagName})`);
                if (this.queueNodeForSave) {
                  this.queueNodeForSave(parentWithId.id, 'update');
                }
                this.modifiedNodes.add(parentWithId.id);
              }
            }
          }
        });
      }
      // Process text changes
      else if (mutation.type === "characterData") {
        let parent = mutation.target.parentNode;

        while (parent && (!parent.id || !/^\d+(\\.\\d+)?$/.test(parent.id))) {
          parent = parent.parentNode;
        }

        if (parent && parent.id) {
          console.log(`Queueing characterData change in parent: ${parent.id}`);

          checkAndInvalidateTocCache(parent.id, parent);

          if (this.queueNodeForSave) {
            this.queueNodeForSave(parent.id, 'update');
          }
          this.modifiedNodes.add(parent.id);
        } else {
          console.warn("characterData change detected but couldn't find parent with ID");
        }
      }
    }

    // Process parent updates
    parentsToUpdate.forEach(parent => {
      console.log(`Queueing parent node after child removal: ${parent.id}`);
      if (this.queueNodeForSave) {
        this.queueNodeForSave(parent.id, 'update');
      }
      this.modifiedNodes.add(parent.id);
    });

    if (addedCount > 0) {
      const BULK_THRESHOLD = 20;
      if (addedCount < BULK_THRESHOLD) {
        console.log(`Queueing ${newNodes.length} new nodes individually`);
        newNodes.forEach(node => {
          if (node.id) {
            console.log(`Queueing new node: ${node.id}`);
            if (this.queueNodeForSave) {
              this.queueNodeForSave(node.id, 'add');
            }
          }
        });
      }
    }
  }

  /**
   * Helper: Destroy a SPAN element while preserving cursor position
   */
  destroySpan(element) {
    const selection = window.getSelection();
    let savedRange = null;
    let cursorWasInSpan = false;
    let cursorOffset = 0;

    if (selection.rangeCount > 0) {
      savedRange = selection.getRangeAt(0);
      if (element.contains(savedRange.startContainer)) {
        cursorWasInSpan = true;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
        let textNode;
        let offset = 0;
        while (textNode = walker.nextNode()) {
          if (textNode === savedRange.startContainer) {
            cursorOffset = offset + savedRange.startOffset;
            break;
          }
          offset += textNode.length;
        }
      }
    }

    let replacementTextNode = null;
    if (element.textContent.trim()) {
      replacementTextNode = document.createTextNode(element.textContent);
      if (element.parentNode && document.contains(element.parentNode)) {
        element.parentNode.insertBefore(replacementTextNode, element);
      }
    }

    if (document.contains(element)) {
      element.remove();
    }

    if (cursorWasInSpan && replacementTextNode) {
      const newRange = document.createRange();
      const safeOffset = Math.min(cursorOffset, replacementTextNode.length);
      newRange.setStart(replacementTextNode, safeOffset);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);
      console.log(`✅ Cursor restored at offset ${safeOffset} after SPAN destruction`);
    }

    return { replacementNode: replacementTextNode, cursorInfo: { cursorWasInSpan, cursorOffset } };
  }

  /**
   * Helper: Check if removed node is a numerical ID deletion
   */
  isNumericalIdDeletion(removedNode, mutationTarget) {
    if (removedNode.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    const nodeId = removedNode.id;
    if (!nodeId || !isNumericalId(nodeId)) {
      return false;
    }

    const parentChunk = this.findContainingChunk(mutationTarget);
    const isWithinMainContent = this.isNodeWithinMainContent(mutationTarget);

    return parentChunk === null && isWithinMainContent;
  }

  /**
   * Helper: Find the .chunk element containing a node
   */
  findContainingChunk(node) {
    if (!node) return null;

    if (node.nodeType !== Node.ELEMENT_NODE) {
      node = node.parentElement;
    }

    while (node && !node.classList?.contains('main-content')) {
      if (node.classList?.contains('chunk')) {
        return node;
      }
      node = node.parentElement;
    }

    return null;
  }

  /**
   * Helper: Find all numerical ID nodes within a chunk
   */
  findNumericalIdNodesInChunk(chunkNode) {
    const numericalIdNodes = [];
    const elementsWithIds = chunkNode.querySelectorAll('[id]');

    elementsWithIds.forEach(element => {
      if (isNumericalId(element.id)) {
        numericalIdNodes.push(element);
      }
    });

    return numericalIdNodes;
  }

  /**
   * Helper: Check if node is within .main-content
   */
  isNodeWithinMainContent(node) {
    if (!node) return false;

    if (node.nodeType !== Node.ELEMENT_NODE) {
      node = node.parentElement;
    }

    while (node) {
      if (node.classList?.contains('main-content')) {
        return true;
      }
      node = node.parentElement;
    }

    return false;
  }
}

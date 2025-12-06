import { batchDeleteIndexedDBRecords } from "../indexedDB/index.js";


export class SelectionDeletionHandler {
  constructor(editorContainer, callbacks = {}) {
    this.editor = editorContainer;
    this.pendingDeletion = null;
    
    // Only need onDeleted callback
    this.onDeleted = callbacks.onDeleted || (() => {});
    
    this.setupListeners();
  }
  
  setupListeners() {
    // Capture selection before deletion
    this.editor.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        this.captureSelectionForDeletion();
      }
    });
    
    // Handle after deletion
    this.editor.addEventListener('input', (e) => {
      if (this.pendingDeletion && 
          (e.inputType === 'deleteContentBackward' || 
           e.inputType === 'deleteContentForward')) {
        
        this.handlePostDeletion();
      }
    });
    
    // Fallback with keyup
    this.editor.addEventListener('keyup', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && 
          this.pendingDeletion) {
        this.handlePostDeletion();
      }
    });
  }
  
  captureSelectionForDeletion() {
  const selection = window.getSelection();

  if (!selection.isCollapsed && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);

    // 🔍 DEBUG: Log selection range details
    console.log('🔍 SELECTION RANGE:', {
      commonAncestor: range.commonAncestorContainer.nodeName,
      commonAncestorClass: range.commonAncestorContainer.className,
      startContainer: range.startContainer.parentElement?.id || range.startContainer.nodeName,
      endContainer: range.endContainer.parentElement?.id || range.endContainer.nodeName,
      startChunk: range.startContainer.parentElement?.closest('.chunk')?.getAttribute('data-chunk-id'),
      endChunk: range.endContainer.parentElement?.closest('.chunk')?.getAttribute('data-chunk-id')
    });

    const affectedElements = this.getAffectedElements(range);

    // 🔥 CAPTURE IDs immediately while elements still exist
    const affectedElementIds = affectedElements.map(el => el.id).filter(id => id);

    // ---- NEW LOGIC ----
    const boundaryElementIds = new Set();
    let startNode = range.startContainer;
    let endNode = range.endContainer;
    // Walk up to find the parent element with a numeric ID
    while (startNode && (!startNode.id || !/^\d+(\.\d+)?$/.test(startNode.id))) {
        startNode = startNode.parentElement;
    }
    while (endNode && (!endNode.id || !/^\d+(\.\d+)?$/.test(endNode.id))) {
        endNode = endNode.parentElement;
    }
    if (startNode && startNode.id) boundaryElementIds.add(startNode.id);
    if (endNode && endNode.id) boundaryElementIds.add(endNode.id);
    // ---- END NEW LOGIC ----
    
    this.pendingDeletion = {
      commonAncestor: range.commonAncestorContainer,
      affectedElements: affectedElements,
      affectedElementIds: affectedElementIds, // ✅ Add this line
      boundaryElementIds: Array.from(boundaryElementIds),
      timestamp: Date.now()
    };
  }
}
  
  getAffectedElements(range) {
    const elements = [];

    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          // Check if node is fully contained in the range, not just intersecting
          try {
            const nodeRange = document.createRange();
            nodeRange.selectNodeContents(node);
            const isFullyContained = range.compareBoundaryPoints(Range.START_TO_START, nodeRange) <= 0 &&
                   range.compareBoundaryPoints(Range.END_TO_END, nodeRange) >= 0;

            return isFullyContained ?
              NodeFilter.FILTER_ACCEPT :
              NodeFilter.FILTER_REJECT;
          } catch (e) {
            // Fallback to intersection if range comparison fails
            return range.intersectsNode(node) ?
              NodeFilter.FILTER_ACCEPT :
              NodeFilter.FILTER_REJECT;
          }
        }
      }
    );

    let node;
    while (node = walker.nextNode()) {
      // Check for numerical IDs (including decimals like 687.3)
      if (node.id && /^\d+(\.\d+)?$/.test(node.id)) {
        elements.push(node);
      }
    }

    return elements;
  }
  
  // In SelectionDeletionHandler
  handlePostDeletion() {
    if (!this.pendingDeletion) return;

    // ✅ SET FLAG: User deletion starting
    import('../utilities/operationState.js').then(module => {
      module.setUserDeletionInProgress(true);
    });

    const nodeIdsToDelete = this.pendingDeletion.affectedElementIds || [];
    const boundaryElementIds = this.pendingDeletion.boundaryElementIds || [];

    // Track stats for summary
    let totalDeleted = 0;
    let totalUpdated = 0;

    // 1. Delete the fully contained nodes
    if (nodeIdsToDelete.length > 0) {
      totalDeleted += nodeIdsToDelete.length;
      this.batchDeleteFromIndexedDB(nodeIdsToDelete);
    }

    // 2. Check which boundary elements still exist in DOM vs were deleted
    const nodesToUpdate = [];
    const additionalNodesToDelete = [];

    boundaryElementIds.forEach(id => {
      if (nodeIdsToDelete.includes(id)) {
        return; // Already marked for deletion
      }

      // Check if element still exists in DOM
      const element = document.getElementById(id);
      if (element) {
        // Element exists, queue for update (content changed)
        nodesToUpdate.push({ id, action: 'update' });
        totalUpdated++;
      } else {
        // Element was deleted from DOM, delete from database too
        additionalNodesToDelete.push(id);
        totalDeleted++;
      }
    });

    // Delete boundary elements that were removed from DOM
    if (additionalNodesToDelete.length > 0) {
      this.batchDeleteFromIndexedDB(additionalNodesToDelete);
    }

    // Update boundary elements that still exist
    if (nodesToUpdate.length > 0) {
      // Dynamically import and call batchUpdateIndexedDBRecords
      import('../indexedDB/index.js').then(module => {
        if (module.batchUpdateIndexedDBRecords) {
          module.batchUpdateIndexedDBRecords(nodesToUpdate);
        } else {
          console.error('❌ batchUpdateIndexedDBRecords function not found');
        }
      }).catch(error => {
        console.error('❌ Error updating boundary elements:', error);
      });
    }

    console.log(`✂️ SELECTION DELETE COMPLETE: ${totalDeleted} deleted, ${totalUpdated} updated`);
    this.pendingDeletion = null;

    // ✅ CLEAR FLAG: Deletion complete (delayed to allow chunk mutations to process)
    setTimeout(() => {
      import('../utilities/operationState.js').then(module => {
        module.setUserDeletionInProgress(false);
      });
    }, 100);
  }

batchDeleteFromIndexedDB(nodeIds) {
  // Import the function if not already imported
  import('../indexedDB/index.js').then(module => {
    const { batchDeleteIndexedDBRecords } = module;
    return batchDeleteIndexedDBRecords(nodeIds);
  }).catch(error => {
    console.error(`❌ Batch deletion failed:`, error);

    // Fallback to individual deletions
    nodeIds.forEach(nodeId => {
      this.onDeleted(nodeId);
    });
  });
}
  
  
  isEffectivelyEmpty(element) {
    return !element.textContent.trim() && 
           !element.querySelector('img, br, hr, video, audio');
  }
  
  findEmptyParagraphs(container) {
    const emptyNodes = [];
    const emptyPs = container.querySelectorAll ? 
      container.querySelectorAll('p[data-block-id]') : 
      this.editor.querySelectorAll('p[data-block-id]');
    
    emptyPs.forEach(p => {
      if (this.isEffectivelyEmpty(p)) {
        emptyNodes.push(p);
      }
    });
    
    return emptyNodes;
  }
  
  deleteNodes(nodes) {
    console.log(`🗑️ Force deleting ${nodes.length} nodes from both DOM and IndexedDB`);
    
    nodes.forEach(node => {
      if (node.id) {
        console.log(`Deleting node ${node.id} from IndexedDB due to selection deletion`);
        
        // 🔥 FORCE the IndexedDB deletion
        deleteIndexedDBRecordWithRetry(node.id).then(() => {
          console.log(`✅ Successfully deleted ${node.id} from IndexedDB`);
        }).catch(error => {
          console.error(`❌ Failed to delete ${node.id} from IndexedDB:`, error);
        });
        
        // Remove from DOM
        node.remove();
      }
    });
    
    // 🔥 ALSO manually trigger the save queue processing
    if (typeof queueNodeForSave === 'function') {
      nodes.forEach(node => {
        if (node.id) {
          queueNodeForSave(node.id, 'delete');
        }
      });
    }
  }
  
  // Optional: cleanup method
  destroy() {
    this.editor = null;
    this.pendingDeletion = null;
    this.onDeleted = null;
  }
}

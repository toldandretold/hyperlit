import { batchDeleteIndexedDBRecords } from "./cache-indexedDB.js";


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
    const affectedElements = this.getAffectedElements(range);
    
    // 🔥 CAPTURE IDs immediately while elements still exist
    const affectedElementIds = affectedElements.map(el => el.id).filter(id => id);
    
    this.pendingDeletion = {
      commonAncestor: range.commonAncestorContainer,
      affectedElements: affectedElements,
      affectedElementIds: affectedElementIds, // ✅ Add this line
      timestamp: Date.now()
    };
    
    console.log('Captured selection for deletion:', this.pendingDeletion);
    console.log('🔍 Captured element IDs:', affectedElementIds);
  }
}
  
  getAffectedElements(range) {
    const elements = [];
    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          return range.intersectsNode(node) ? 
            NodeFilter.FILTER_ACCEPT : 
            NodeFilter.FILTER_REJECT;
        }
      }
    );
    
    let node;
    while (node = walker.nextNode()) {
      if (node.hasAttribute('data-block-id')) {
        elements.push(node);
      }
    }
    
    return elements;
  }
  
  // In SelectionDeletionHandler
  handlePostDeletion() {
  if (!this.pendingDeletion) {
    console.log("❌ No pendingDeletion found");
    return;
  }
  
  console.log('Handling post-deletion cleanup');
  console.log('🔍 pendingDeletion:', this.pendingDeletion);
  
  // Check if we have the affectedElementIds
  const nodeIdsToDelete = this.pendingDeletion.affectedElementIds || [];
  console.log('🔍 nodeIdsToDelete:', nodeIdsToDelete);
  
  if (nodeIdsToDelete.length === 0) {
    console.log("❌ No node IDs to delete - checking affectedElements");
    
    // Fallback: extract IDs from affectedElements
    const fallbackIds = this.pendingDeletion.affectedElements
      .map(el => el.id)
      .filter(id => id);
    
    console.log('🔍 fallbackIds:', fallbackIds);
    
    if (fallbackIds.length > 0) {
      console.log(`🗑️ Using fallback IDs: ${fallbackIds.length} elements`);
      this.batchDeleteFromIndexedDB(fallbackIds);
    }
  } else {
    console.log(`🗑️ Batch deleting ${nodeIdsToDelete.length} elements from IndexedDB`);
    this.batchDeleteFromIndexedDB(nodeIdsToDelete);
  }
  
  this.pendingDeletion = null;
}

batchDeleteFromIndexedDB(nodeIds) {
  console.log('🔍 About to call batchDeleteIndexedDBRecords with:', nodeIds);
  
  // Import the function if not already imported
  import('./cache-indexedDB.js').then(module => {
    const { batchDeleteIndexedDBRecords } = module;
    
    return batchDeleteIndexedDBRecords(nodeIds);
  }).then(() => {
    console.log(`✅ Successfully batch deleted ${nodeIds.length} records`);
  }).catch(error => {
    console.error(`❌ Batch deletion failed:`, error);
    
    // Fallback to individual deletions
    nodeIds.forEach(nodeId => {
      console.log(`Fallback: deleting ${nodeId} individually`);
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

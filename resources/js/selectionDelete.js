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
      
      this.pendingDeletion = {
        commonAncestor: range.commonAncestorContainer,
        affectedElements: this.getAffectedElements(range),
        timestamp: Date.now()
      };
      
      console.log('Captured selection for deletion:', this.pendingDeletion);
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
  
  handlePostDeletion() {
    if (!this.pendingDeletion) return;
    
    console.log('Handling post-deletion cleanup');
    
    const nodesToDelete = [];
    
    // Check affected elements - collect nodes that should be deleted
    this.pendingDeletion.affectedElements.forEach(element => {
      if (this.isEffectivelyEmpty(element)) {
        console.log('Found empty element to delete:', element.id);
        nodesToDelete.push(element);
      }
    });
    
    // Clean up any other empty paragraphs in the area
    const additionalEmptyNodes = this.findEmptyParagraphs(this.pendingDeletion.commonAncestor);
    nodesToDelete.push(...additionalEmptyNodes);
    
    // Actually delete the nodes from DOM and IndexedDB
    this.deleteNodes(nodesToDelete);
    
    this.pendingDeletion = null;
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
    nodes.forEach(node => {
      if (node.id) {
        console.log(`Deleting node ${node.id} from IndexedDB due to selection deletion`);
        
        // Call the deletion callback
        this.onDeleted(node.id);
        
        // Remove from DOM
        node.remove();
      }
    });
  }
  
  // Optional: cleanup method
  destroy() {
    this.editor = null;
    this.pendingDeletion = null;
    this.onDeleted = null;
  }
}

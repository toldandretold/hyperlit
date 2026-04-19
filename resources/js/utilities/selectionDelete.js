import { batchDeleteIndexedDBRecords } from "../indexedDB/index.js";
import { queueForSync } from '../indexedDB/syncQueue/queue.js';


export class SelectionDeletionHandler {
  constructor(editorContainer, callbacks = {}) {
    this.editor = editorContainer;
    this.pendingDeletion = null;

    // Accept queue callbacks
    this.queueNodeForDeletion = callbacks.queueNodeForDeletion || null;
    this.queueNodeForSave = callbacks.queueNodeForSave || null;

    this.setupListeners();
  }
  
  setupListeners() {
    // Capture selection before deletion
    this.editor.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Check for content links first — unwrap them instead of deleting text
        if (this.checkAndUnwrapLinks(e)) return;
        // Check for special elements (hypercites, footnotes) — warn before deleting
        if (this.checkForSpecialElements(e)) return;
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
  
  /**
   * If a non-collapsed selection intersects user-created content links,
   * unwrap them (remove <a>, keep text) instead of deleting text.
   * Returns true if links were unwrapped (caller should skip normal deletion).
   */
  checkAndUnwrapLinks(e) {
    if (!window.isEditing) return false;
    const selection = window.getSelection();
    if (selection.isCollapsed || selection.rangeCount === 0) return false;

    const range = selection.getRangeAt(0);
    const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;
    const searchRoot = root?.closest('p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id], li[id], ol[id], ul[id], .main-content, [data-book-id]') || root;
    if (!searchRoot || !searchRoot.querySelectorAll) return false;

    const anchors = searchRoot.querySelectorAll('a[href]');
    const linksToUnwrap = [];

    for (const anchor of anchors) {
      // Inline isContentLink checks to keep synchronous
      const href = anchor.getAttribute('href');
      if (!href) continue;
      if (anchor.classList.contains('footnote-ref')) continue;
      if (anchor.id && anchor.id.startsWith('hypercite_')) continue;
      if (anchor.closest('sup[fn-count-id]')) continue;
      if (anchor.closest('.hypercites-section, .citations-section, .hypercite-citation-section')) continue;

      try {
        const anchorRange = document.createRange();
        anchorRange.selectNodeContents(anchor);
        const intersects = range.compareBoundaryPoints(Range.END_TO_START, anchorRange) <= 0 &&
                         anchorRange.compareBoundaryPoints(Range.END_TO_START, range) <= 0;
        if (intersects) linksToUnwrap.push(anchor);
      } catch (err) { /* ignore */ }
    }

    if (linksToUnwrap.length === 0) return false;

    // Prevent browser from deleting text
    e.preventDefault();

    import('./operationState.js').then(({ setProgrammaticUpdateInProgress }) => {
      setProgrammaticUpdateInProgress(true);
      try {
        const affectedNodeIds = new Set();
        linksToUnwrap.forEach(anchor => {
          const container = anchor.closest(
            "p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id], li[id], ol[id], ul[id]"
          );
          if (container && container.id) {
            affectedNodeIds.add(container.id);
          }
          // Inline unwrap
          const parent = anchor.parentNode;
          if (!parent) return;
          while (anchor.firstChild) {
            parent.insertBefore(anchor.firstChild, anchor);
          }
          parent.removeChild(anchor);
          if (typeof parent.normalize === 'function') parent.normalize();
        });

        // Queue affected nodes for save
        if (this.queueNodeForSave) {
          affectedNodeIds.forEach(nodeId => {
            this.queueNodeForSave(nodeId, 'update');
          });
        }
        console.log(`✅ Keyboard unwrapped ${linksToUnwrap.length} content links`);
      } finally {
        setProgrammaticUpdateInProgress(false);
      }
    });

    return true;
  }

  /**
   * Check if a non-collapsed selection contains special elements
   * (source hypercites, hypercite citation links, footnotes).
   * If found, preventDefault and show a combined confirmation dialog.
   * Returns true if special elements were found (caller should skip normal deletion).
   */
  checkForSpecialElements(e) {
    if (!window.isEditing) return false;
    const selection = window.getSelection();
    if (selection.isCollapsed || selection.rangeCount === 0) return false;

    const range = selection.getRangeAt(0);
    const root = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;
    const searchRoot = root?.closest('p[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], blockquote[id], table[id], li[id], ol[id], ul[id], .main-content, [data-book-id]') || root;
    if (!searchRoot || !searchRoot.querySelectorAll) return false;

    // Find special elements that intersect the selection
    const sourceHypercites = [];
    for (const el of searchRoot.querySelectorAll('u[id^="hypercite_"]')) {
      if (this._rangeIntersectsNode(range, el)) sourceHypercites.push(el);
    }

    const hyperciteLinks = [];
    for (const el of searchRoot.querySelectorAll('a[href*="#hypercite_"]')) {
      if (this._rangeIntersectsNode(range, el)) hyperciteLinks.push(el);
    }

    const footnotes = [];
    for (const el of searchRoot.querySelectorAll('sup[fn-count-id]')) {
      if (this._rangeIntersectsNode(range, el)) footnotes.push(el);
    }

    if (sourceHypercites.length === 0 && hyperciteLinks.length === 0 && footnotes.length === 0) {
      return false;
    }

    // Special elements found — prevent default and handle asynchronously
    e.preventDefault();
    this._handleSpecialElementDeletion(range, sourceHypercites, hyperciteLinks, footnotes);
    return true;
  }

  /**
   * Check if a Range intersects a given DOM node.
   */
  _rangeIntersectsNode(range, node) {
    try {
      const nodeRange = document.createRange();
      nodeRange.selectNodeContents(node);
      return range.compareBoundaryPoints(Range.END_TO_START, nodeRange) <= 0 &&
             nodeRange.compareBoundaryPoints(Range.END_TO_START, range) <= 0;
    } catch (err) {
      return false;
    }
  }

  /**
   * Async handler for selection-deleting special elements.
   * Looks up citation counts, builds a combined warning, and executes deletion if confirmed.
   */
  async _handleSpecialElementDeletion(range, sourceHypercites, hyperciteLinks, footnotes) {
    try {
      // Look up citation counts for source hypercites
      let citedSourceCount = 0;
      let totalCitedIN = 0;
      const uncitedSources = [];

      if (sourceHypercites.length > 0) {
        const { openDatabase } = await import('../indexedDB/index.js');
        const { getHyperciteById } = await import('../hypercites/database.js');
        const db = await openDatabase();

        for (const el of sourceHypercites) {
          const hypercite = await getHyperciteById(db, el.id);
          const citedINCount = (hypercite?.citedIN?.length) || 0;
          if (citedINCount > 0) {
            citedSourceCount++;
            totalCitedIN += citedINCount;
          } else {
            uncitedSources.push(el);
          }
        }
      }

      // Only warn if there's something worth warning about
      const hasWarning = citedSourceCount > 0 || hyperciteLinks.length > 0 || footnotes.length > 0;

      if (hasWarning) {
        // Build combined warning message
        const parts = [];
        if (citedSourceCount > 0) {
          parts.push(`${citedSourceCount} hypercited text(s) cited in ${totalCitedIN} other book(s)`);
        }
        if (hyperciteLinks.length > 0) {
          parts.push(`${hyperciteLinks.length} hypercite citation link(s)`);
        }
        if (footnotes.length > 0) {
          const fnNums = footnotes.map(s => s.getAttribute('fn-count-id')).join(', ');
          parts.push(`footnote(s) ${fnNums}`);
        }

        const confirmed = confirm(`Selection contains: ${parts.join(', ')}. Delete anyway?`);
        if (!confirmed) return; // User cancelled — selection stays intact
      }

      // User confirmed (or no warning needed) — execute the deletion
      const { setProgrammaticUpdateInProgress } = await import('./operationState.js');
      setProgrammaticUpdateInProgress(true);

      try {
        // Queue footnote delink syncs while <sup> elements are still in DOM
        for (const sup of footnotes) {
          const footnoteId = sup.id || sup.getAttribute('fn-count-id');
          const fnBook = sup.closest('[data-book-id]')?.getAttribute('data-book-id')
            || document.querySelector('.main-content')?.id;
          if (footnoteId && fnBook) {
            queueForSync('footnotes', footnoteId, 'delete', { book: fnBook, footnoteId });
          }
        }

        // Re-select the range (confirm dialog may have cleared it)
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        // Capture affected elements before deletion
        this.captureSelectionForDeletion();

        // Execute the deletion — MutationObserver handles tombstone creation
        document.execCommand('delete', false, null);

        // Run post-deletion IndexedDB cleanup
        this.handlePostDeletion();
      } finally {
        setProgrammaticUpdateInProgress(false);
      }
    } catch (error) {
      console.error('❌ Error in _handleSpecialElementDeletion:', error);
    }
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
      // ⚠️ DIAGNOSTIC: Log when selection delete affects many nodes
      if (nodeIdsToDelete.length > 10) {
        console.warn(`⚠️ SELECTION DELETE: ${nodeIdsToDelete.length} nodes`, {
          stack: new Error().stack,
          nodeIds: nodeIdsToDelete.slice(0, 10),
          timestamp: Date.now()
        });
      }
      if (this.queueNodeForDeletion) {
        // ✅ Use saveQueue for debounced batching
        nodeIdsToDelete.forEach(id => {
          this.queueNodeForDeletion(id);
        });
      } else {
        // Fallback to direct deletion if queue not available
        this.batchDeleteFromIndexedDB(nodeIdsToDelete);
      }
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
      if (this.queueNodeForDeletion) {
        // ✅ Use saveQueue for debounced batching
        additionalNodesToDelete.forEach(id => {
          this.queueNodeForDeletion(id);
        });
      } else {
        // Fallback to direct deletion if queue not available
        this.batchDeleteFromIndexedDB(additionalNodesToDelete);
      }
    }

    // Update boundary elements that still exist
    if (nodesToUpdate.length > 0) {
      if (this.queueNodeForSave) {
        // ✅ Use saveQueue for debounced batching
        nodesToUpdate.forEach(node => {
          this.queueNodeForSave(node.id, node.action);
        });
      } else {
        // Fallback to direct batch update
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

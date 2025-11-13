/**
 * DOM Utility Functions for divEditor
 *
 * This module contains utility functions for DOM manipulation and document structure management:
 * - handleHyperciteRemoval() - handles deletion of hypercite links and delinks them
 * - ensureMinimumDocumentStructure() - ensures document always has valid structure (sentinels + chunks + content)
 * - checkForImminentEmptyState() - checks if document is about to become empty
 * - cleanupStyledSpans() - removes browser-generated styled span elements
 *
 * These functions are used by divEditor.js and chunkMutationHandler.js to maintain
 * document integrity during editing operations.
 */

import { book } from '../app.js';
import { isNumericalId, setElementIds } from "../utilities/IDfunctions.js";
import { verbose } from '../utilities/logger.js';
import { isPasteOperationActive } from '../paste';
import { trackChunkNodeCount } from '../chunkManager.js';

/**
 * Check if a removed node is a hypercite element and handle delinking
 * @param {Node} removedNode - The node that was removed
 */
export async function handleHyperciteRemoval(removedNode) {
  // Helper function to verify removal with optional delay
  const verifyRemoval = async (hyperciteId, delay = 0) => {
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    return !document.getElementById(hyperciteId);
  };

  // ✅ CHECK 1: Anchor tags that LINK TO hypercites (pasted citations)
  if (removedNode.nodeType === Node.ELEMENT_NODE &&
      removedNode.tagName === 'A' &&
      removedNode.href) {

    // Check if this is a link to a hypercite (contains #hypercite_)
    const href = removedNode.href;
    const hyperciteMatch = href.match(/#(hypercite_[a-z0-9]+)/);

    if (hyperciteMatch) {
      const targetHyperciteId = hyperciteMatch[1];

      // Verify the link is truly deleted (not just moved)
      const immediateCheck = await verifyRemoval(removedNode.id || targetHyperciteId);
      const delayedCheck = immediateCheck ? await verifyRemoval(removedNode.id || targetHyperciteId, 50) : false;

      if (!delayedCheck) {
        console.log(`✅ Hypercite link ${targetHyperciteId} still exists in DOM - skipping delink`);
        return;
      }

      console.log(`🔗 Hypercite citation link deleted, target: ${targetHyperciteId}`);
      console.log(`📍 Href: ${href}`);

      try {
        // Extract just the hypercite ID from the removed node (if it has one)
        // The delinkHypercite function needs just the ID, not the full URL
        const deletedLinkId = removedNode.id || targetHyperciteId;

        if (window.testDelinkHypercite) {
          await window.testDelinkHypercite(deletedLinkId, href);
        } else {
          const { delinkHypercite } = await import('../hypercites/index.js');
          await delinkHypercite(deletedLinkId, href);
        }
      } catch (error) {
        console.error('❌ Error handling hypercite link removal:', error);
      }

      return; // Exit early, we've handled this case
    }
  }

  // ✅ CHECK 2: Source hypercite <u> wrappers being deleted
  // TODO: Phase 2 - Replace with tombstone anchor instead of allowing deletion
  if (removedNode.nodeType === Node.ELEMENT_NODE &&
      removedNode.tagName === 'U' &&
      removedNode.id &&
      removedNode.id.startsWith('hypercite_')) {

    console.log(`⚠️ Source hypercite <u> wrapper deleted: ${removedNode.id}`);
    console.log(`📌 TODO: This should be prevented and replaced with tombstone <a> tag`);
    // For now, just log it - Phase 2 will handle this properly

    return;
  }

  // ✅ CHECK 3: Handle nested hypercite links within deleted containers
  if (removedNode.nodeType === Node.ELEMENT_NODE && removedNode.querySelectorAll) {
    const hyperciteLinks = removedNode.querySelectorAll('a[href*="#hypercite_"]');

    if (hyperciteLinks.length > 0) {
      console.log(`🔗 Found ${hyperciteLinks.length} hypercite links within removed element`);

      for (const link of hyperciteLinks) {
        const href = link.href;
        const hyperciteMatch = href.match(/#(hypercite_[a-z0-9]+)/);

        if (hyperciteMatch) {
          const targetHyperciteId = hyperciteMatch[1];

          // Verify deletion
          const immediateCheck = await verifyRemoval(link.id || targetHyperciteId);
          const delayedCheck = immediateCheck ? await verifyRemoval(link.id || targetHyperciteId, 50) : false;

          if (!delayedCheck) {
            console.log(`✅ Nested hypercite link ${targetHyperciteId} still exists - skipping`);
            continue;
          }

          try {
            // Extract just the hypercite ID from the removed link (if it has one)
            const deletedLinkId = link.id || targetHyperciteId;

            if (window.testDelinkHypercite) {
              await window.testDelinkHypercite(deletedLinkId, href);
            } else {
              const { delinkHypercite } = await import('../hypercites/index.js');
              await delinkHypercite(deletedLinkId, href);
            }
          } catch (error) {
            console.error('❌ Error handling nested hypercite link removal:', error);
          }
        }
      }
    }
  }
}

/**
 * Find all nodes with numerical IDs within a container (helper function)
 * @param {HTMLElement} container - The container element to search within
 * @returns {Array<HTMLElement>} - Array of elements with numerical IDs
 */
export function findAllNumericalIdNodesInChunks(container) {
  const numericalIdNodes = [];
  const elementsWithIds = container.querySelectorAll('[id]');

  elementsWithIds.forEach(element => {
    if (isNumericalId(element.id)) {
      numericalIdNodes.push(element);
    }
  });

  return numericalIdNodes;
}

/**
 * Ensure the document always has minimum valid structure:
 * - Top and bottom sentinels
 * - At least one chunk
 * - At least one content node (paragraph with ID "1")
 *
 * This function is called:
 * - When document becomes empty (last node deleted)
 * - When observer starts (to ensure initial structure)
 * - When paste operations might have cleared content
 *
 * @param {Function} queueNodeForSave - Function to queue nodes for saving to database
 */
export function ensureMinimumDocumentStructure(queueNodeForSave) {
  verbose.content('ensureMinimumDocumentStructure() called', 'domUtilities.js');

  const mainContent = document.querySelector('.main-content');
  if (!mainContent) {
    verbose.content('No .main-content found - exiting', 'domUtilities.js');
    return;
  }

  // ✅ CHECK FOR IMPORTED BOOK FIRST
  const isImportedBook = sessionStorage.getItem('imported_book_initializing');
  if (isImportedBook) {
    verbose.content('Imported book detected - skipping document structure creation', 'domUtilities.js');
    return; // Exit early, don't create default structure
  }

  // ✅ CHECK FOR PASTE OPERATION IN PROGRESS
  const pasteActive = isPasteOperationActive();
  if (pasteActive) {
    verbose.content('Paste operation in progress - skipping document structure creation', 'domUtilities.js');
    return; // Exit early, don't interfere with paste operation
  }

  verbose.content('Proceeding with structure check', 'domUtilities.js');

  const bookId = book;

  // Check for sentinels
  const topSentinelId = `${bookId}-top-sentinel`;
  const bottomSentinelId = `${bookId}-bottom-sentinel`;
  const hasTopSentinel = document.getElementById(topSentinelId);
  const hasBottomSentinel = document.getElementById(bottomSentinelId);

  // Check for chunks
  const chunks = mainContent.querySelectorAll('.chunk');

  // Check for numerical ID nodes
  const numericalIdNodes = findAllNumericalIdNodesInChunks(mainContent);
  const nonSentinelNodes = numericalIdNodes.filter(node =>
    !node.id.includes('-sentinel')
  );

  verbose.content(`Found: ${chunks.length} chunks, ${numericalIdNodes.length} numerical nodes (${nonSentinelNodes.length} non-sentinel)`, 'domUtilities.js');
  verbose.content(`Sentinel status - Top: ${!!hasTopSentinel}, Bottom: ${!!hasBottomSentinel}`, 'domUtilities.js');
  verbose.content(`Non-sentinel node IDs: ${nonSentinelNodes.map(n => n.id).join(', ')}`, 'domUtilities.js');

  // 🆕 COLLECT ORPHANED CONTENT FIRST, before any structure changes
  const orphanedContent = [];
  Array.from(mainContent.childNodes).forEach(node => {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      orphanedContent.push(node);
    } else if (node.nodeType === Node.ELEMENT_NODE &&
               !node.classList.contains('chunk') &&
               !node.classList.contains('sentinel')) {
      orphanedContent.push(node);
    }
  });

  if (orphanedContent.length > 0) {
    console.log(`🧹 Found ${orphanedContent.length} orphaned content nodes to preserve`);
  }

  // CASE 1: Create missing sentinels
  if (!hasTopSentinel) {
    console.log('📍 Creating top sentinel...');
    const topSentinel = document.createElement('div');
    topSentinel.id = topSentinelId;
    topSentinel.className = 'sentinel';

    mainContent.insertBefore(topSentinel, mainContent.firstChild);
    queueNodeForSave(topSentinelId, 'add');
    console.log(`✅ Created top sentinel: ${topSentinelId}`);
  }

  if (!hasBottomSentinel) {
    console.log('📍 Creating bottom sentinel...');
    const bottomSentinel = document.createElement('div');
    bottomSentinel.id = bottomSentinelId;
    bottomSentinel.className = 'sentinel';

    mainContent.appendChild(bottomSentinel);
    queueNodeForSave(bottomSentinelId, 'add');
    console.log(`✅ Created bottom sentinel: ${bottomSentinelId}`);
  }

  // CASE 2: No chunks OR no content nodes - create default structure
  if (chunks.length === 0 || nonSentinelNodes.length === 0) {
    verbose.content('CASE 2: Creating default document structure', 'domUtilities.js');

    // Preserve existing title content if it exists
    const existingTitle = mainContent.querySelector('h1');
    const preservedTitleContent = existingTitle ? existingTitle.innerHTML : null;
    console.log('📝 Preserved title content:', preservedTitleContent);

    // 🆕 PRESERVE orphaned content by temporarily removing it from DOM
    const preservedContent = orphanedContent.map(node => {
      const clone = node.cloneNode(true);
      node.remove(); // Remove from DOM but keep the clone
      return clone;
    });

    // Clear any remaining content (except sentinels)
    Array.from(mainContent.children).forEach(child => {
      if (!child.classList.contains('sentinel')) {
        child.remove();
      }
    });

    // Create chunk between sentinels
    const chunk = document.createElement('div');
    chunk.className = 'chunk';
    chunk.setAttribute('data-chunk-id', '0');

    // Create default paragraph
    const p = document.createElement('p');
    // Use setElementIds to set both id and data-node-id
    setElementIds(p, null, null, book);
    // Force id to be "1" (setElementIds might generate something else)
    if (p.id !== '1') {
      p.id = '1';
      p.setAttribute('data-node-id', `${book}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
    }

    // 🆕 RESTORE TITLE CONTENT FIRST (highest priority)
    if (preservedTitleContent) {
      console.log('✅ Restoring preserved title content');
      p.innerHTML = preservedTitleContent;
    }
    // Otherwise, add preserved orphaned content
    else if (preservedContent.length > 0) {
      console.log('📝 Restoring preserved content to new paragraph');
      preservedContent.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          p.appendChild(node);
        } else {
          // For element nodes, move their content
          while (node.firstChild) {
            p.appendChild(node.firstChild);
          }
        }
      });
    }
    // Otherwise, create empty but editable paragraph
    else {
      p.innerHTML = '<br>';
    }

    // Assemble structure
    chunk.appendChild(p);

    // Insert before bottom sentinel
    const bottomSentinel = document.getElementById(bottomSentinelId);
    if (bottomSentinel) {
      mainContent.insertBefore(chunk, bottomSentinel);
    } else {
      mainContent.appendChild(chunk);
    }

    // Save to database
    queueNodeForSave('1', 'add');

    // Initialize chunk tracking
    if (window.trackChunkNodeCount) {
      trackChunkNodeCount(chunk);
    }

    console.log('✅ Created default structure with preserved content');

    // Position cursor in the new paragraph
    setTimeout(() => {
      const range = document.createRange();
      const selection = window.getSelection();
      range.selectNodeContents(p);
      range.collapse(false); // Collapse to end
      selection.removeAllRanges();
      selection.addRange(range);
    }, 0);

    return;
  }

  // CASE 3: Has chunks but they're empty - add content to first chunk
  if (chunks.length > 0 && nonSentinelNodes.length === 0) {
    verbose.content('CASE 3: Adding content to existing empty chunk', 'domUtilities.js');

    const firstChunk = chunks[0];
    const p = document.createElement('p');

    // Use setElementIds to set both id and data-node-id
    setElementIds(p, null, null, book);
    // Force id to be "1"
    if (p.id !== '1') {
      p.id = '1';
      p.setAttribute('data-node-id', `${book}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
    }

    // 🆕 ADD ORPHANED CONTENT TO THE NEW PARAGRAPH
    if (orphanedContent.length > 0) {
      console.log('📝 Adding orphaned content to new paragraph in existing chunk');
      orphanedContent.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          p.appendChild(node);
        } else {
          while (node.firstChild) {
            p.appendChild(node.firstChild);
          }
          node.remove();
        }
      });
    } else {
      p.innerHTML = '<br>';
    }

    firstChunk.appendChild(p);
    queueNodeForSave('1', 'add');

    console.log('✅ Added p#1 to existing chunk with content');
    return;
  }

  // CASE 4: Normal case - just handle orphaned content if any exists
  if (orphanedContent.length > 0) {
    console.log('📝 Moving orphaned content to existing structure...');

    let targetChunk = mainContent.querySelector('.chunk');
    let targetElement = targetChunk?.querySelector('[id]:not([id*="-sentinel"])');

    if (!targetElement) {
      // This shouldn't happen in normal case, but just in case
      targetElement = document.createElement('p');
      targetElement.id = '1';
      if (targetChunk) {
        targetChunk.appendChild(targetElement);
      }
    }

    // Move orphaned content to the target element
    orphanedContent.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        targetElement.appendChild(node);
      } else {
        while (node.firstChild) {
          targetElement.appendChild(node.firstChild);
        }
        node.remove();
      }
    });

    queueNodeForSave(targetElement.id, 'update');
    console.log('✅ Moved orphaned content to existing element');
  }

  verbose.content('✅ Document structure is adequate - no changes needed', 'domUtilities.js');
}

/**
 * Check if the document is about to become empty (down to last node)
 * Used to prevent complete document deletion and trigger structure restoration
 *
 * @returns {boolean} - True if document will be empty after next deletion
 */
export function checkForImminentEmptyState() {
  const mainContent = document.querySelector('.main-content');
  if (!mainContent) {
    console.log(`🔍 [IMMINENT EMPTY] No main-content found, returning false`);
    return false;
  }

  const numericalIdNodes = findAllNumericalIdNodesInChunks(mainContent);
  const nonSentinelNodes = numericalIdNodes.filter(node =>
    !node.id.includes('-sentinel')
  );

  console.log(`🔍 [IMMINENT EMPTY] Found ${numericalIdNodes.length} numerical nodes, ${nonSentinelNodes.length} non-sentinel nodes`);
  console.log(`🔍 [IMMINENT EMPTY] Node IDs: ${nonSentinelNodes.map(n => n.id).join(', ')}`);

  // If we're down to 1 node, we're about to be empty
  const result = nonSentinelNodes.length <= 1;
  console.log(`🔍 [IMMINENT EMPTY] Returning: ${result}`);
  return result;
}

// ================================================================
// TARGETED SPAN CLEANUP (replaces periodic cleanup)
// ================================================================

/**
 * Clean up styled spans from a container.
 * Called after specific operations (paste, import) rather than periodically.
 *
 * @param {HTMLElement} container - Container to clean (or null for entire document)
 */
export function cleanupStyledSpans(container = null) {
  const searchRoot = container || document.querySelector('.main-content');
  if (!searchRoot) return;

  const spans = searchRoot.querySelectorAll('span[style]');
  if (spans.length === 0) return;

  console.log(`🧹 Targeted cleanup: Found ${spans.length} styled spans to remove`);

  spans.forEach(span => {
    // Preserve text content but remove the span wrapper
    if (span.textContent.trim()) {
      const textNode = document.createTextNode(span.textContent);
      if (span.parentNode && document.contains(span.parentNode)) {
        span.parentNode.insertBefore(textNode, span);
      }
    }

    if (document.contains(span)) {
      span.remove();
    }
  });

  console.log(`✅ Cleaned up ${spans.length} styled spans`);
}

/**
 * Clean up styled spans after document import.
 * Should be called once after the entire import process completes.
 */
export function cleanupAfterImport() {
  console.log('🧹 Running post-import span cleanup...');
  cleanupStyledSpans();
}

/**
 * Clean up styled spans after paste operation.
 * Should be called after paste content is processed.
 *
 * @param {HTMLElement} pastedContainer - Container with pasted content
 */
export function cleanupAfterPaste(pastedContainer) {
  console.log('🧹 Running post-paste span cleanup...');
  cleanupStyledSpans(pastedContainer);
}

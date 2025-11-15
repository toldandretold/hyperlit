/**
 * Console Hacks - Emergency Recovery Utilities
 *
 * This file contains utility functions that can be copied into the browser console
 * for emergency data recovery and debugging.
 *
 * IMPORTANT: These functions are NOT imported into the main application.
 * They are reference implementations that you can copy/paste into the browser console
 * when needed.
 */

/**
 * EMERGENCY DOM RESCUE FUNCTION
 *
 * USE CASE:
 * When the DOM order doesn't match the database order (e.g., after a failed paste
 * operation or if IDs got corrupted), this function will:
 *
 * 1. Read all elements with data-node-id in current DOM order
 * 2. Assign new sequential IDs (100, 200, 300, etc.) based on their visual position
 * 3. Update the DOM immediately with new IDs
 * 4. Preserve all existing hyperlights, hypercites, and footnotes
 * 5. Update IndexedDB with the correct order
 * 6. Sync everything to PostgreSQL
 *
 * HOW TO USE:
 * 1. Copy the entire rescueCurrentDOM() function below
 * 2. Paste it into your browser console (F12 → Console tab)
 * 3. Press Enter to run it
 * 4. Wait for "DONE! Reload page." message
 * 5. Reload the page - content will now be in correct order
 *
 * WHAT IT FIXES:
 * - Content appearing in wrong order after paste
 * - Duplicate IDs causing content to disappear
 * - IndexedDB/PostgreSQL out of sync with DOM
 * - Content loss due to incorrect startLine values
 *
 * SAFETY:
 * - Preserves all data-node-id values (node identity maintained)
 * - Preserves all hyperlights, hypercites, footnotes
 * - Disables mutation observer during operation
 * - Only affects the current book (doesn't touch other books)
 */

async function rescueCurrentDOM() {
  try {
    var bookElement = document.querySelector('.main-content');
    var currentBook = bookElement ? bookElement.id : null;
    if (!currentBook) {
      console.error('No book found');
      return false;
    }
    console.log('Book:', currentBook);
    var allDomElements = Array.from(document.querySelectorAll('[data-node-id]'));
    if (allDomElements.length === 0) {
      console.error('No elements');
      return false;
    }
    console.log('Found', allDomElements.length, 'elements');
    var updates = [];
    for (var i = 0; i < allDomElements.length; i++) {
      var element = allDomElements[i];
      var newStartLine = (i + 1) * 100;
      var oldId = element.id;
      var nodeId = element.getAttribute('data-node-id');
      var content = element.outerHTML;

      // Strip <mark> tags (highlights are injected on page load, shouldn't be saved)
      var cleanContent = content.replace(/<mark[^>]*>/g, '').replace(/<\/mark>/g, '');

      // Update the ID
      var updatedContent = cleanContent.replace(/id="[^"]+"/g, 'id="' + newStartLine + '"');

      updates.push({
        book: currentBook,
        oldStartLine: parseFloat(oldId) || 0,
        newStartLine: newStartLine,
        node_id: nodeId,
        content: updatedContent,
        chunk_id: Math.floor(i / 100),
        element: element
      });
    }
    console.log('Generated', updates.length, 'updates');
    window.renumberingInProgress = true;
    for (var i = 0; i < updates.length; i++) {
      updates[i].element.id = updates[i].newStartLine.toString();
    }
    console.log('DOM updated');
    var dbRequest = indexedDB.open('MarkdownDB');
    var db = await new Promise(function(resolve, reject) {
      dbRequest.onsuccess = function() { resolve(dbRequest.result); };
      dbRequest.onerror = function() { reject(dbRequest.error); };
    });
    console.log('DB opened');
    var tx = db.transaction('nodes', 'readonly');
    var store = tx.objectStore('nodes');
    var bookIndex = store.index('book');
    var getAllRequest = bookIndex.getAll(currentBook);
    var existingNodes = await new Promise(function(resolve, reject) {
      getAllRequest.onsuccess = function() { resolve(getAllRequest.result); };
      getAllRequest.onerror = function() { reject(getAllRequest.error); };
    });
    var existingNodesMap = new Map();
    for (var i = 0; i < existingNodes.length; i++) {
      var node = existingNodes[i];
      if (node.node_id) {
        existingNodesMap.set(node.node_id, node);
      }
    }
    console.log('Found', existingNodesMap.size, 'nodes in DB');
    var deleteTx = db.transaction('nodes', 'readwrite');
    var deleteStore = deleteTx.objectStore('nodes');
    for (var i = 0; i < existingNodes.length; i++) {
      var node = existingNodes[i];
      await deleteStore.delete([node.book, node.startLine]);
    }
    await new Promise(function(resolve, reject) {
      deleteTx.oncomplete = resolve;
      deleteTx.onerror = function() { reject(deleteTx.error); };
    });
    console.log('Deleted', existingNodes.length, 'old records');
    var writeTx = db.transaction('nodes', 'readwrite');
    var writeStore = writeTx.objectStore('nodes');
    for (var i = 0; i < updates.length; i++) {
      var update = updates[i];
      var existingNode = existingNodesMap.get(update.node_id);
      var newRecord = {
        book: update.book,
        startLine: update.newStartLine,
        chunk_id: update.chunk_id,
        content: update.content,
        node_id: update.node_id,
        hyperlights: existingNode ? (existingNode.hyperlights || []) : [],
        hypercites: existingNode ? (existingNode.hypercites || []) : [],
        footnotes: existingNode ? (existingNode.footnotes || []) : []
      };
      await writeStore.put(newRecord);
    }
    await new Promise(function(resolve, reject) {
      writeTx.oncomplete = resolve;
      writeTx.onerror = function() { reject(writeTx.error); };
    });
    console.log('IndexedDB updated');
    var csrfToken = document.querySelector('meta[name="csrf-token"]');
    var dataToSend = [];
    for (var i = 0; i < updates.length; i++) {
      var u = updates[i];
      var existingNode = existingNodesMap.get(u.node_id);
      dataToSend.push({
        book: u.book,
        startLine: u.newStartLine,
        chunk_id: u.chunk_id,
        content: u.content,
        node_id: u.node_id,
        hyperlights: existingNode ? (existingNode.hyperlights || []) : [],
        hypercites: existingNode ? (existingNode.hypercites || []) : [],
        footnotes: existingNode ? (existingNode.footnotes || []) : []
      });
    }
    var response = await fetch('/api/db/node-chunks/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrfToken ? csrfToken.content : ''
      },
      credentials: 'include',
      body: JSON.stringify({
        book: currentBook,
        data: dataToSend
      })
    });
    if (!response.ok) {
      var errorText = await response.text();
      console.error('Sync failed:', errorText);
      throw new Error('Sync failed');
    }
    var result = await response.json();
    console.log('Synced:', result);

    // Update library timestamp to mark book as recently modified
    var timestamp = Date.now();
    var timestampResponse = await fetch('/api/db/library/update-timestamp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-TOKEN': csrfToken ? csrfToken.content : ''
      },
      credentials: 'include',
      body: JSON.stringify({
        book: currentBook,
        timestamp: timestamp
      })
    });

    if (timestampResponse.ok) {
      console.log('Library timestamp updated:', timestamp);
    } else {
      console.warn('Failed to update library timestamp (non-critical)');
    }

    window.renumberingInProgress = false;
    console.log('DONE! Reload page.');
    return true;
  } catch (error) {
    console.error('ERROR:', error.message);
    window.renumberingInProgress = false;
    return false;
  }
}

// Example: To run this, copy the rescueCurrentDOM() function above and paste into console, then call:
// rescueCurrentDOM();

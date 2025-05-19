// BroadcastListener.js

import { book } from "./app.js"; // current book identifier
import { applyHypercites, applyHighlights } from "./lazyLoaderFactory.js"; // adjust path as needed
import { attachUnderlineClickListeners } from "./hyperCites.js";

export function initializeBroadcastListener() {
  const channel = new BroadcastChannel("node-updates");

  channel.addEventListener("message", (event) => {
    // Destructure with alias to avoid naming collisions.
    const { book: incomingBook, startLine } = event.data;
    if (incomingBook === book) {
      console.log(`Received update for node with startLine: ${startLine}`);
      updateDomNode(startLine);
    }
  });
}

/**
 * updateDomNode:
 * Retrieves the latest record from IndexedDB, runs it through the content
 * processing functions, and then updates the corresponding DOM node.
 */
// This function needs to be async now to handle the potential async nature
// of getting the record (though your example uses .then, which is fine).
// For clarity and modern JavaScript, making it async/await is better.
async function updateDomNode(startLine) {
  console.group(`updateDomNode(${startLine})`);
  console.log(`Starting update for node ID: ${startLine}`);
  
  try {
    const record = await getNodeChunkByKey(book, startLine);
    console.log(`Retrieved record from IndexedDB:`, record);
    
    if (record) {
      console.log(`Original content from DB:`, record.content);
      
      // Get the current DOM node
      const node = document.getElementById(startLine);
      
      if (!node) {
        console.warn(`⚠️ No DOM element found with id=${startLine}`);
        return;
      }
      
      console.log(`Found DOM node:`, node);
      console.log(`Current node HTML before update:`, node.outerHTML);
      
      // Only process hypercites - we don't need to reapply highlights
      if (record.hypercites && record.hypercites.length > 0) {
        console.log(`Applying hypercites:`, record.hypercites);
        
        // Create a temporary div with the current DOM content
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = node.innerHTML;
        
        // Find all <u> elements in the temp div
        const underlineTags = tempDiv.querySelectorAll('u');
        
        // Create another temp div with the content from the record
        // to extract the relationship classes
        const recordTempDiv = document.createElement('div');
        let processedContent = sanitizeContent(record.content || "");
        processedContent = applyHypercites(processedContent, record.hypercites);
        recordTempDiv.innerHTML = processedContent;
        
        // Get all <u> elements from the processed content
        const processedUnderlines = recordTempDiv.querySelectorAll('u');
        
        // Map of citation IDs to their relationship classes
        const citationClassMap = {};
        processedUnderlines.forEach(u => {
          const citationId = u.getAttribute('data-citation-id');
          if (citationId) {
            citationClassMap[citationId] = u.className;
          }
        });
        
        // Now update only the classes on the actual DOM node's <u> elements
        const actualUnderlines = node.querySelectorAll('u');
        actualUnderlines.forEach(u => {
          const citationId = u.getAttribute('data-citation-id');
          if (citationId && citationClassMap[citationId]) {
            // Only update the class, preserving the element and its contents
            u.className = citationClassMap[citationId];
          }
        });
        
        console.log(`Updated only the classes of <u> tags`);
        console.log(`Node HTML after update:`, node.outerHTML);
      } else {
        console.log(`No hypercites to apply`);
      }
      
      // Re-attach listeners after updating the DOM
      attachUnderlineClickListeners();
      console.log(`Attached underline click listeners`);
    } else {
      console.warn(`⚠️ No record returned for key [${book}, ${startLine}]`);
    }
  } catch (error) {
    console.error("❌ Error updating DOM node:", error);
    console.error("Error stack:", error.stack);
  } finally {
    console.groupEnd();
  }
}





function sanitizeContent(html) {
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = html;
  // Remove the outer h1 if it exists.
  const h1 = tempDiv.querySelector("h1");
  if (h1 && h1.innerHTML) {
    return h1.innerHTML;
  }
  return html;
}
/** 
 * getNodeChunkByKey:
 * Returns a Promise that resolves to the nodeChunk record for the given book 
 * and startLine from IndexedDB.
 */
function getNodeChunkByKey(book, startLine) {
  return new Promise((resolve, reject) => {
    const dbName = "MarkdownDB";
    const storeName = "nodeChunks";
    const request = indexedDB.open(dbName);

    request.onerror = (event) => {
      console.error(`IndexedDB error: ${event.target.errorCode}`);
      reject(event.target.error);
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      const transaction = db.transaction([storeName], "readonly");
      const objectStore = transaction.objectStore(storeName);
      const key = [book, startLine];
      const getRequest = objectStore.get(key);

      getRequest.onerror = (event) => {
        console.error("Error getting record:", event.target.error);
        resolve(null);
      };

      getRequest.onsuccess = (event) => {
        resolve(event.target.result);
      };

      transaction.oncomplete = () => {
        db.close();
      };
    };
  });
}

export function broadcastToOpenTabs(booka, startLine) {
  const channel = new BroadcastChannel("node-updates");
  console.log(
    `Broadcasting update: book=${booka}, startLine=${startLine}`
  );
  channel.postMessage({
    book: booka,
    startLine,
  });
}

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
    const record = await getNodeChunkByKey(book, startLine); // Await the promise

    console.log(`Retrieved record from IndexedDB:`, record);
    
    if (record) {
      // Log the original content from IndexedDB
      console.log(`Original content from DB:`, record.content);
      
      // Process content
      let newContent = record.content || "";
      console.log(`Initial content (or empty string):`, newContent);
      
      newContent = sanitizeContent(newContent);
      console.log(`After sanitizeContent():`, newContent);
      
      if (record.hypercites && record.hypercites.length > 0) {
        console.log(`Applying hypercites:`, record.hypercites);
        // Pass the hypercites array directly from the record
        newContent = applyHypercites(newContent, record.hypercites); 
        console.log(`After applyHypercites():`, newContent);
      } else {
        console.log(`No hypercites to apply`);
      }
      
      // Assuming applyHighlights is synchronous or already handles async internally
      if (record.highlights && record.highlights.length > 0) {
        console.log(`Applying highlights:`, record.highlights);
        newContent = applyHighlights(newContent, record.highlights);
        console.log(`After applyHighlights():`, newContent);
      } else {
        console.log(`No highlights to apply`);
      }

      // Locate the DOM node
      const node = document.getElementById(startLine);
      
      if (node) {
        console.log(`Found DOM node:`, node);
        console.log(`Current node HTML before update:`, node.outerHTML);
        
        // Create a temporary div to parse the content
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = newContent;
        
        console.log(`Parsed content in tempDiv:`, tempDiv.innerHTML);
        
        // Find the root element in the parsed content
        const rootElement = tempDiv.firstElementChild;
        console.log(`Root element from parsed content:`, rootElement);
        
        if (rootElement && rootElement.tagName === node.tagName) {
          console.log(`Tags match: ${rootElement.tagName} = ${node.tagName}`);
          console.log(`Using innerHTML from root element:`, rootElement.innerHTML);
          node.innerHTML = rootElement.innerHTML;
        } else {
          if (rootElement) {
            console.log(`Tags don't match: ${rootElement.tagName} ≠ ${node.tagName}`);
          } else {
            console.log(`No root element found in parsed content`);
          }
          console.log(`Using entire newContent:`, newContent);
          node.innerHTML = newContent;
        }
        
        console.log(`Node HTML after update:`, node.outerHTML);
        
        // Re-attach listeners after updating the DOM
        attachUnderlineClickListeners();
        console.log(`Attached underline click listeners`);
      } else {
        console.warn(`⚠️ No DOM element found with id=${startLine}`);
      }
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

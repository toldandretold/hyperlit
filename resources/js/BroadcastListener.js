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
function updateDomNode(startLine) {
  getNodeChunkByKey(book, startLine)
    .then((record) => {
      if (record) {
        // Assume record.content holds your raw HTML.
        let newContent = record.content || "";
        newContent = sanitizeContent(newContent);
        if (record.hypercites && record.hypercites.length > 0) {
          newContent = applyHypercites(newContent, record.hypercites);
        }
        if (record.highlights && record.highlights.length > 0) {
          newContent = applyHighlights(newContent, record.highlights);
        }

        // Locate the DOM node with id equal to startLine.
        const node = document.getElementById(startLine);
        if (node) {
          console.log(`Updating node id=${startLine} with processed content.`);
          node.innerHTML = newContent;
          attachUnderlineClickListeners();

        } else {
          console.warn(`No DOM element found with id=${startLine}`);
        }
      } else {
        console.warn(`No record returned for key [${book}, ${startLine}]`);
      }
    })
    .catch((error) => console.error("Error updating DOM node:", error));
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
      const key = [book, parseInt(startLine, 10)];
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

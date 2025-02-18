/* Lazy Loading Logic [: as i understand it]

[haven't done this yet] If a lazy-load.json doesn’t already exist that is update more recently than the main-text.md, 

The main-text.md is processed to generate / update the lazy-load.json [not as a saved file yet, but as: window.nodeChunks = parseMarkdownIntoChunks(window.markdownContent);], and it is saved as browser memory.

This .jason stores: 

- data-chunk-id: number of each chunk of blocks and lines to be lazy loaded 
- data-block-id: Block number 
- id: Md line number 

On page load, lazy-load.jason is used to:

- convert the first chunk of md blocks to html 
- Pit in DOM within: div.id=“data-chunk-id”
- insert sentinels at top and bottom of this chunk 
- listen for when top or bottom sentinel node gets to either the top or bottom of the viewport/rootMargin
- when it does, check if the next highest chunk (numerically, from the one that the tracked html node id is in) is in the DOM
- If it isn’t, lazy load it.

When Navigating to internal links: 

- extract the id of internal link
- search for it in the DOM
- if it is there, navigate to it, to centre of viewport 
- if not, use .jason to determine which chunk its in, load that chunk and one above and below.
- put sentinels above and below this new "contiguous range of chunks"
- clear nodes outside this range (could change this if needed)
- so now lazy loading works up and down... 

*/
  

// ============================================================
// Adjusting the Page Initialization
// ============================================================


import {
  book,
  mainContentDiv
} from './reader-DOMContentLoaded.js';

// cache-indexedDB.js


 // lazy-loading.js
import {
  openDatabase,
  DB_VERSION,
  checkIndexedDBSize,
  getNodeChunksFromIndexedDB,
  saveNodeChunksToIndexedDB,
  getFootnotesFromIndexedDB,
  saveFootnotesToIndexedDB,
  clearIndexedDB
} from './cache-indexedDB.js';

import {
    attachMarkListeners,
    handleMarkClick,
    handleMarkHover,
    handleMarkHoverOut
} from './hyper-lights-cites.js';

import {
  parseMarkdownIntoChunks,
} from './convert-markdown.js';

import {
  injectFootnotesForChunk
} from './footnotes.js';

import {
    renderBlockToHtml
} from './convert-markdown.js';

export async function loadMarkdownFile() {
  console.log("🚀 ENTERING loadMarkdownFile()...");

  let cachedServerTimestamp = localStorage.getItem("markdownLastModified") || "null";
  console.log("📂 Cached Server Timestamp BEFORE request:", cachedServerTimestamp);

  try {
    console.log("🔍 Fetching latest Markdown update info...");
    let response = await fetch(`/markdown/${book}/latest_update.json?v=${Date.now()}`);
    if (!response.ok) {
      console.error("⚠️ Could not fetch latest update info. Using cached data.");
      return;
    }

    let data = await response.json();
    let serverTimestamp = data.updated_at.toString();
    console.log("✅ Server reported Markdown last updated at:", serverTimestamp);

    const oldTimestamp = Number(cachedServerTimestamp);
    const newTimestamp = Number(serverTimestamp);
    console.log(`🔍 COMPARING TIMESTAMPS -> cached: ${oldTimestamp}, server: ${newTimestamp}`);

    if (oldTimestamp !== newTimestamp) {
      console.log("❌ TIMESTAMPS DIFFER: Performing Full Reload...");

      localStorage.setItem("markdownLastModified", serverTimestamp);
      console.log("🚀 Updated localStorage timestamp:", serverTimestamp);

      localStorage.removeItem("savedChunks");
      await clearIndexedDB();
      console.log("🗑 Cleared old savedChunks & IndexedDB. Fetching fresh Markdown...");

      window.jsonPath = `/markdown/${book}/main-text-footnotes.json?v=${Date.now()}`;
      console.log("📑 Updated jsonPath for footnotes:", window.jsonPath);

      // ✅ Load footnotes from IndexedDB first
       let footnotesData = await getFootnotesFromIndexedDB();
          if (footnotesData) {
            console.log("✅ Footnotes loaded from IndexedDB.");
          } else {
            console.log("⚠️ No footnotes found in IndexedDB. Fetching from server...");
            console.log("✅ window.jsonPath:", window.jsonPath); // Add this line
            try {
              let footnotesResponse = await fetch(window.jsonPath);
              if (footnotesResponse.ok) {
                footnotesData = await footnotesResponse.json();
                await saveFootnotesToIndexedDB(footnotesData);
                console.log("✅ Footnotes successfully saved to IndexedDB.");
              } else {
                console.warn("⚠️ Failed to fetch footnotes JSON, using fallback.");
              }
            } catch (error) {
              console.error("❌ Error fetching footnotes JSON:", error);
            }
        }

      // --- NEW LOGIC STARTS HERE: Check for existing nodeChunks.json ---
      let nodeChunksFetched = false;
      try {
        console.log("🔍 Checking if /markdown/" + book + "/nodeChunks.json is available...");
        let chunksResponse = await fetch(`/markdown/${book}/nodeChunks.json?v=${Date.now()}`);
        if (chunksResponse.ok) {
          let nodeChunksData = await chunksResponse.json();
          await saveNodeChunksToIndexedDB(nodeChunksData);
          window.nodeChunks = nodeChunksData;
          console.log("✅ Imported nodeChunks from nodeChunks.json and saved to IndexedDB.");
          nodeChunksFetched = true;
        } else {
          console.warn("⚠️ nodeChunks.json not found or not accessible. Will parse from main-text.md");
        }
      } catch (e) {
        console.error("❌ Error fetching nodeChunks.json:", e);
      }

      // If nodeChunks.json wasn't found, fallback to original parsing logic
      if (!nodeChunksFetched) {
        console.log("🚦 Fallback: Fetching and parsing main-text.md locally...");
        response = await fetch(`/markdown/${book}/main-text.md?v=${Date.now()}`);
        let markdown = await response.text();

        window.nodeChunks = parseMarkdownIntoChunks(markdown);
        console.log(`📏 Parsed ${window.nodeChunks.length} nodeChunks from main-text.md`);

        await saveNodeChunksToIndexedDB(window.nodeChunks);
        console.log("✅ nodeChunks successfully saved in IndexedDB.");
      }

      window.savedChunks = {
        timestamp: serverTimestamp,
        chunks: []
      };
      localStorage.setItem("savedChunks", JSON.stringify(window.savedChunks));

      // ✅ Ensure no premature DOM updates before Lazy Loading
      if (!window.nodeChunks || window.nodeChunks.length === 0) {
        console.error("❌ nodeChunks is empty after processing. Aborting lazy loading.");
        return;
      }

      initializeLazyLoadingFixed();
      return;
    }

    console.log("✅ Timestamps match! Using IndexedDB cache...");
    let cachedNodeChunks = await getNodeChunksFromIndexedDB();

    if (cachedNodeChunks.length > 0) {
      console.log("✅ Using cached nodeChunks from IndexedDB.");
      window.nodeChunks = cachedNodeChunks;
    } else {
      console.log("⚠️ No valid nodeChunks found in IndexedDB. Must fetch Markdown.");
      response = await fetch(`/markdown/${book}/main-text.md?v=${Date.now()}`);
      let markdown = await response.text();

      window.nodeChunks = parseMarkdownIntoChunks(markdown);
      await saveNodeChunksToIndexedDB(window.nodeChunks);
      console.log("✅ Parsed and stored nodeChunks from fresh Markdown.");
    }

    // ✅ Load footnotes from IndexedDB if not already loaded
    let footnotesData = await getFootnotesFromIndexedDB();
    if (footnotesData) {
      console.log("✅ Using cached footnotes from IndexedDB.");
    } else {
      console.log("⚠️ No valid footnotes found in IndexedDB. Fetching from server...");
      let footnotesResponse = await fetch(window.jsonPath);
      footnotesData = await footnotesResponse.json();
      await saveFootnotesToIndexedDB(footnotesData);
      console.log("✅ Fetched and stored footnotes from server.");
    }

    if (!window.nodeChunks || window.nodeChunks.length === 0) {
      console.error("❌ nodeChunks is empty. Aborting lazy loading.");
      return;
    }
    initializeLazyLoadingFixed();
  } catch (error) {
    console.error("❌ Error loading Markdown:", error);
  }
}




// CHUNKY CHUNKY
// ============================================================
// Fixed Sentinel Setup for a Contiguous Block
// ============================================================

export function initializeLazyLoadingFixed() {
    // Initial checks
    if (!window.nodeChunks || window.nodeChunks.length === 0) {
        console.error("🚨 nodeChunks is empty! Aborting lazy loading initialization.");
        return;
    }

    if (window.isRestoringFromCache) {
        console.log("🚀 Skipping lazy loading because cached chunks were restored.");
        attachMarkListeners();
        return;
    }

    // Cleanup previous observer if it exists
    if (window.fixedSentinelObserver) {
        window.fixedSentinelObserver.disconnect();
        console.log("🧹 Previous observer disconnected");
    }

    // Remove existing sentinels
    document.querySelectorAll(".sentinel").forEach(sentinel => sentinel.remove());
    console.log("🧹 Existing sentinels removed");

    // Create new sentinels
    let topSentinel = document.createElement("div");
    topSentinel.id = "top-sentinel";
    topSentinel.classList.add("sentinel");

    let bottomSentinel = document.createElement("div");
    bottomSentinel.id = "bottom-sentinel";
    bottomSentinel.classList.add("sentinel");

    mainContentDiv.prepend(topSentinel);
    mainContentDiv.appendChild(bottomSentinel);
    console.log("✨ New sentinels created and inserted");

    attachMarkListeners();

    // Define observer options with larger rootMargin for easier triggering
    const options = {
        root: mainContentDiv,
        rootMargin: "100px", // Increased from 50px
        threshold: 0
    };

    const observer = new IntersectionObserver((entries) => {
        console.log("👀 Intersection Observer triggered", entries.length, "entries");
        
        if (window.isNavigatingToInternalId || window.isUpdatingJsonContent) {
            console.log("⏳ Navigation in progress; skipping lazy-load triggers.");
            return;
        }

        entries.forEach(entry => {
            console.log(`🎯 Entry for ${entry.target.id}, isIntersecting: ${entry.isIntersecting}`);
            
            if (!entry.isIntersecting) return;

            if (entry.target.id === "bottom-sentinel") {
                const lastChunkEl = getLastChunkElement();
                if (lastChunkEl) {
                    const lastChunkId = parseInt(lastChunkEl.getAttribute("data-chunk-id"), 10);
                    console.log(`📍 Bottom sentinel triggered, last chunk ID: ${lastChunkId}`);
                    loadNextChunkFixed(lastChunkId);
                } else {
                    console.warn("⚠️ No last chunk element found");
                }
            }

            if (entry.target.id === "top-sentinel") {
                const firstChunkEl = mainContentDiv.querySelector("[data-chunk-id]");
                if (firstChunkEl) {
                    const firstChunkId = parseInt(firstChunkEl.getAttribute("data-chunk-id"), 10);
                    if (firstChunkId > 0 && !window.currentlyLoadedChunks.has(firstChunkId - 1)) {
                        console.log(`🟢 Loading previous chunk ${firstChunkId - 1}`);
                        loadPreviousChunkFixed(firstChunkId);
                    }
                }
            }
        });
    }, options);

    // Start observing
    observer.observe(topSentinel);
    observer.observe(bottomSentinel);

    attachMarkListeners();

    // Store references globally
    window.fixedSentinelObserver = observer;
    window.topSentinel = topSentinel;
    window.bottomSentinel = bottomSentinel;

    console.log("🕒 Sentinels observation started with options:", options);
}

// A helper to get the last chunk element currently in the DOM.
function getLastChunkElement() {
  const chunks = document.querySelectorAll("[data-chunk-id]");
  if (chunks.length === 0) return null;
  return chunks[chunks.length - 1];
}


// ============================================================
// Revised Chunk Loading Functions (Fixed Sentinel Version)
// ============================================================

// Loads the previous chunk and repositions the top sentinel.
function loadPreviousChunkFixed(currentFirstChunkId) {
  const previousChunkId = currentFirstChunkId - 1;
  if (previousChunkId < 0) {
    console.warn("🚫 No previous chunks to load.");
    return;
  }
  // If already loaded, do nothing.
  if (document.querySelector(`[data-chunk-id="${previousChunkId}"]`)) {
    console.log(`✅ Previous chunk ${previousChunkId} is already loaded.`);
    return;
  }
  
  const prevChunk = window.nodeChunks.find(chunk => chunk.chunk_id === previousChunkId);
  if (!prevChunk) {
    console.warn(`❌ No data found for chunk ${previousChunkId}.`);
    return;
  }
  
  console.log(`🟢 Loading previous chunk (loadPreviousChunkFixed): ${previousChunkId}`);
  const scrollContainer = document.getElementById("main-content");
  
  // Store current scroll position
  const prevScrollTop = scrollContainer.scrollTop;
  
  // Create and insert the new chunk at the top.
  const chunkWrapper = createChunkElement(prevChunk);
  scrollContainer.insertBefore(chunkWrapper, scrollContainer.firstElementChild);
  window.currentlyLoadedChunks.add(previousChunkId);
  
  // Measure the new chunk's height.
  const newChunkHeight = chunkWrapper.getBoundingClientRect().height;
  
  // Adjust the scroll so the content remains anchored.
  scrollContainer.scrollTop = prevScrollTop + newChunkHeight;
  
  // Reposition the fixed top sentinel to be immediately before the first chunk.
  if (window.topSentinel) {
    window.topSentinel.remove();
    scrollContainer.prepend(window.topSentinel);
  }
}


// Loads the next chunk and repositions the bottom sentinel.
function loadNextChunkFixed(currentLastChunkId) {
  const nextChunkId = currentLastChunkId + 1;
  // If already loaded, do nothing.
  if (document.querySelector(`[data-chunk-id="${nextChunkId}"]`)) {
    console.log(`✅ Next chunk ${nextChunkId} is already loaded.`);
    return;
  }

  const nextChunk = window.nodeChunks.find(chunk => chunk.chunk_id === nextChunkId);
  if (!nextChunk) {
    console.warn(`❌ No data found for chunk ${nextChunkId}.`);
    return;
  }

  console.log(`🟢 Loading next chunk: ${nextChunkId}`);
  const mainContentDiv = document.getElementById("main-content");
  const chunkWrapper = createChunkElement(nextChunk);
  mainContentDiv.appendChild(chunkWrapper);
  window.currentlyLoadedChunks.add(nextChunkId);

  // Reposition the bottom sentinel: remove it and re-append it.
  if (window.bottomSentinel) {
    window.bottomSentinel.remove();
    mainContentDiv.appendChild(window.bottomSentinel);
  }
}

// ✅ Creates a chunk element with sentinels
function createChunkElement(chunk) {
    const chunkWrapper = document.createElement("div");
    chunkWrapper.setAttribute("data-chunk-id", chunk.chunk_id);
    chunkWrapper.classList.add("chunk");

    chunk.blocks.forEach(block => {
        const html = renderBlockToHtml(block);
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = html;
        chunkWrapper.appendChild(tempDiv);
    });
    return chunkWrapper;
}


// ✅ Get the first chunk currently in the DOM
function getFirstChunkId() {
    const firstChunk = document.querySelector("[data-chunk-id]");
    return firstChunk ? parseInt(firstChunk.getAttribute("data-chunk-id"), 10) : null;
}


// ✅ Get the last chunk currently in the DOM
export function getLastChunkId() {
    const chunks = document.querySelectorAll("[data-chunk-id]");
    if (chunks.length === 0) return null;
    return parseInt(chunks[chunks.length - 1].getAttribute("data-chunk-id"), 10);
}

function insertChunkInOrder(newChunk) {
    const mainContentDiv = document.getElementById("main-content");
    const existingChunks = [...mainContentDiv.querySelectorAll("[data-chunk-id]")];

    let inserted = false;
    const newChunkId = parseInt(newChunk.getAttribute("data-chunk-id"), 10);

    for (let i = 0; i < existingChunks.length; i++) {
        const existingChunkId = parseInt(existingChunks[i].getAttribute("data-chunk-id"), 10);
        
        if (newChunkId < existingChunkId) {
            mainContentDiv.insertBefore(newChunk, existingChunks[i]);
            inserted = true;
            break;
        }
    }

    // If it wasn't inserted, append it to the end
    if (!inserted) {
        mainContentDiv.appendChild(newChunk);
    }

    console.log(`✅ Inserted chunk ${newChunkId} in the correct order.`);
}


export function loadChunk(chunkId, direction = "down") {
    console.log(`🟢 Loading chunk: ${chunkId}, direction: ${direction}`);

    // Initialize currentlyLoadedChunks if it doesn't exist
    if (!window.currentlyLoadedChunks) {
        window.currentlyLoadedChunks = new Set();
    }

    // Check if the chunk is already loaded
    if (window.currentlyLoadedChunks.has(chunkId)) {
        console.log(`✅ Chunk ${chunkId} is already loaded. Skipping.`);
        return;
    }

    // Find the chunk data
    const chunk = window.nodeChunks.find(c => c.chunk_id === chunkId);
    if (!chunk) {
        console.error(`❌ Chunk ${chunkId} not found!`);
        // Show meaningful message instead of blank page
        if (chunkId === 0) {
            document.getElementById("main-content").innerHTML = 
                "<p>Unable to load content. Please refresh the page.</p>";
        }
        return;
    }

    // Create and insert the chunk
    const chunkWrapper = createChunkElement(chunk);
    const mainContentDiv = document.getElementById("main-content");
    
    if (direction === "up") {
        mainContentDiv.insertBefore(chunkWrapper, mainContentDiv.firstChild);
    } else {
        mainContentDiv.appendChild(chunkWrapper);
    }

    // Mark chunk as loaded
    window.currentlyLoadedChunks.add(chunkId);

    
    attachMarkListeners();
    
    
    // If this is the first chunk (chunkId === 0), make sure sentinels are properly positioned
    if (chunkId === 0) {
        repositionFixedSentinelsForBlock();
    }

    
    // Add this line before the final console.log
    injectFootnotesForChunk(chunkId);

    console.log(`✅ Chunk ${chunkId} loaded successfully.`);
}





// SENTINEL SHIT FOR INTERNAL ID NAVIGATION // 

/**
 * Removes all loaded chunks whose data-chunk-id is not in the allowedIds array.
 */
function removeChunksOutside(allowedIds) {
  const mainContentDiv = document.getElementById("main-content");
  const allChunks = mainContentDiv.querySelectorAll("[data-chunk-id]");
  allChunks.forEach(chunk => {
    const chunkId = parseInt(chunk.getAttribute("data-chunk-id"), 10);
    if (!allowedIds.includes(chunkId)) {
      console.log(`Removing chunk ${chunkId} as it is outside the new block.`);
      chunk.remove();
      // Also remove the chunk from your tracking set, if needed:
      window.currentlyLoadedChunks.delete(chunkId);
    }
  });
}



/**
 * Repositions the fixed top and bottom sentinels so that they wrap
 * exactly the new contiguous block of chunks.
 */
export function repositionFixedSentinelsForBlock() {
    const mainContentDiv = document.getElementById("main-content");
    const allChunks = [...mainContentDiv.querySelectorAll("[data-chunk-id]")];
    if (allChunks.length === 0) {
        console.warn("No chunks in the DOM to reposition sentinels around.");
        return;
    }

    // Sort chunks by ID to ensure correct positioning
    allChunks.sort((a, b) => {
        return parseInt(a.getAttribute("data-chunk-id")) - 
               parseInt(b.getAttribute("data-chunk-id"));
    });

    // Disconnect observer before removing sentinels
    if (window.fixedSentinelObserver) {
        window.fixedSentinelObserver.disconnect();
    }

    if (window.topSentinel) window.topSentinel.remove();
    if (window.bottomSentinel) window.bottomSentinel.remove();

    let topSentinel = document.createElement("div");
    topSentinel.id = "top-sentinel";
    topSentinel.className = "sentinel";

    let bottomSentinel = document.createElement("div");
    bottomSentinel.id = "bottom-sentinel";
    bottomSentinel.className = "sentinel";

    // Insert sentinels
    mainContentDiv.insertBefore(topSentinel, allChunks[0]);
    allChunks[allChunks.length - 1].after(bottomSentinel);

    // Update global references
    window.topSentinel = topSentinel;
    window.bottomSentinel = bottomSentinel;

    // Reconnect observer
    if (window.fixedSentinelObserver) {
        window.fixedSentinelObserver.observe(topSentinel);
        window.fixedSentinelObserver.observe(bottomSentinel);
        console.log("🔄 Sentinels repositioned and observation restarted");
    }

    // Update currently loaded chunks set
    window.currentlyLoadedChunks = new Set(
        allChunks.map(chunk => parseInt(chunk.getAttribute("data-chunk-id")))
    );
}



function loadContentAroundLine(lineNumber) {
    console.log(`🟢 Loading content around line: ${lineNumber}`);

    // Find the chunk that contains this line
    const targetChunk = window.nodeChunks.find(chunk =>
        lineNumber >= chunk.start_line && lineNumber <= chunk.end_line
    );

    if (!targetChunk) {
        console.warn(`❌ No chunk found for line ${lineNumber}.`);
        return;
    }

    console.log(`✅ Line ${lineNumber} is in chunk ${targetChunk.chunk_id}.`);

    // Track chunks to load
    const chunksToLoad = new Set([targetChunk.chunk_id]);

    // Add adjacent chunks if needed
    if (lineNumber - targetChunk.start_line < 5) {
        const prevChunkId = targetChunk.chunk_id - 1;
        if (prevChunkId >= 0) chunksToLoad.add(prevChunkId);
    }

    if (targetChunk.end_line - lineNumber < 5) {
        const nextChunkId = targetChunk.chunk_id + 1;
        if (nextChunkId < window.nodeChunks.length) chunksToLoad.add(nextChunkId);
    }

    // Load all needed chunks
    const loadPromises = Array.from(chunksToLoad).map(chunkId => {
        return new Promise(resolve => {
            if (!window.currentlyLoadedChunks.has(chunkId)) {
                loadChunk(chunkId, chunkId < targetChunk.chunk_id ? "up" : "down");
            }
            resolve();
        });
    });

    // After loading chunks, reposition sentinels and scroll
    Promise.all(loadPromises).then(() => {
        repositionFixedSentinelsForBlock();

        attachMarkListeners();
        
        setTimeout(() => {
            const targetElement = document.getElementById(lineNumber.toString());
            if (targetElement) {
                console.log(`✅ Scrolling to line: ${lineNumber}`);
                scrollElementIntoMainContent(targetElement, 50);
            } else {
                console.error(`❌ Line "${lineNumber}" not found after loading.`);
            }
        }, 100);
    });
}





    function loadContentAroundId(targetId) {
    console.log(`🟢 Loading content around ID: ${targetId}`);

    const targetLine = findLineForId(markdownContent, targetId);
    if (targetLine === null) {
        console.warn(`❌ Target ID "${targetId}" not found in Markdown.`);
        return;
    }

    console.log(`✅ Found ID "${targetId}" at line ${targetLine}`);

    // ✅ Use the updated function to load content based on line number
    loadContentAroundLine(targetLine);

    // ✅ Ensure content is fully loaded before scrolling
    setTimeout(() => {
        const newTargetElement = document.getElementById(targetId);
        if (newTargetElement) {
            console.log(`✅ Scrolling to target ID: ${targetId}`);
            newTargetElement.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
            console.error(`❌ ID "${targetId}" still not found after loading.`);
        }
    }, 200); // Delay ensures content loads first
}








// ========= Scrolling =========
function scrollElementIntoMainContent(targetElement, headerOffset = 0) {
  const container = document.getElementById("main-content");
  if (!container) {
    console.error('Container with id "main-content" not found!');
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const elementRect = targetElement.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const offset = elementRect.top - containerRect.top + container.scrollTop;
  const targetScrollTop = offset - headerOffset;
  console.log("Element rect:", elementRect);
  console.log("Container rect:", containerRect);
  console.log("Container current scrollTop:", container.scrollTop);
  console.log("Calculated targetScrollTop:", targetScrollTop);
  container.scrollTo({
    top: targetScrollTop,
    behavior: "smooth"
  });
}
window.scrollElementIntoMainContent = scrollElementIntoMainContent;

function lockScrollToTarget(targetElement, headerOffset = 50, attempts = 3) {
  let count = 0;
  const interval = setInterval(() => {
    scrollElementIntoMainContent(targetElement, headerOffset);
    count++;
    if (count >= attempts) clearInterval(interval);
  }, 300);
}
window.lockScrollToTarget = lockScrollToTarget;



// 🔹 Save the topmost visible Markdown element (excluding sentinels)
function saveScrollPosition(elementId) {
    if (!elementId) return;

    console.log(`📝 Saving topmost visible element: ${elementId}`);

    sessionStorage.setItem(SCROLL_KEY, elementId);
    localStorage.setItem(SCROLL_KEY, elementId);

    const targetChunk = window.nodeChunks.find(chunk =>
        chunk.blocks.some(block => block.startLine.toString() === elementId)
    );

    if (!targetChunk) {
        console.warn(`❌ No chunk found for top element ${elementId}.`);
        return;
    }

    const targetChunkId = targetChunk.chunk_id;
    const prevChunk = window.nodeChunks.find(chunk => chunk.chunk_id === targetChunkId - 1);
    const nextChunk = window.nodeChunks.find(chunk => chunk.chunk_id === targetChunkId + 1);

    const savedChunks = {
        timestamp: localStorage.getItem("markdownLastModified") || Date.now().toString(), // 🔥 Set timestamp
        chunks: [
            { id: prevChunk?.chunk_id, html: document.querySelector(`[data-chunk-id="${prevChunk?.chunk_id}"]`)?.outerHTML || null },
            { id: targetChunkId, html: document.querySelector(`[data-chunk-id="${targetChunkId}"]`)?.outerHTML || null },
            { id: nextChunk?.chunk_id, html: document.querySelector(`[data-chunk-id="${nextChunk?.chunk_id}"]`)?.outerHTML || null }
        ].filter(chunk => chunk.html) // Remove nulls
    };

    localStorage.setItem("savedChunks", JSON.stringify(savedChunks));
    console.log("💾 Saved chunks:", savedChunks);
}

window.saveScrollPosition = saveScrollPosition;

async function restoreScrollPosition() {
    console.log("📌 Attempting to restore scroll position...");

    const hash = window.location.hash.substring(1);
    let targetId = hash;

    // Only try to get stored positions if storage is available
    try {
        if (sessionStorage) {
            const sessionSavedId = sessionStorage.getItem("lastVisibleElement");
            if (!targetId && sessionSavedId) targetId = sessionSavedId;
        }
    } catch (e) {
        console.log("⚠️ sessionStorage not available");
    }

    try {
        if (localStorage) {
            const localSavedId = localStorage.getItem("lastVisibleElement");
            if (!targetId && localSavedId) targetId = localSavedId;
        }
    } catch (e) {
        console.log("⚠️ localStorage not available");
    }

    // If no target ID was found, load the first chunk
    if (!targetId) {
        console.log("🟢 No saved position found. Loading first chunk...");
        
        // Check if we have nodeChunks in memory or IndexedDB
        let cachedNodeChunks = await getNodeChunksFromIndexedDB();
        if (cachedNodeChunks && cachedNodeChunks.length > 0) {
            console.log("✅ Found nodeChunks in IndexedDB. Loading first chunk...");
            window.nodeChunks = cachedNodeChunks;
            
            // Clear main content and load first chunk
            const mainContentDiv = document.getElementById("main-content");
            mainContentDiv.innerHTML = "";
            loadChunk(0, "down");  // Load the first chunk
            
            return;
        }
        
        // If no cached chunks, fetch from main-text.md
        console.log("⚠️ No cached chunks found. Fetching from main-text.md...");
        try {
            const response = await fetch(`/markdown/${book}/main-text.md`);
            const markdown = await response.text();
            window.nodeChunks = parseMarkdownIntoChunks(markdown);
            loadChunk(0, "down");  // Load the first chunk
        } catch (error) {
            console.error("❌ Error loading main-text.md:", error);
            // Show a meaningful message instead of blank page
            document.getElementById("main-content").innerHTML = 
                "<p>Unable to load content. Please refresh the page.</p>";
        }
        return;
    }

    // If we have a target ID, proceed with navigation
    console.log(`🎯 Found target position: ${targetId}. Navigating...`);
    navigateToInternalId(targetId);
}

window.restoreScrollPosition = restoreScrollPosition;






/**
 * Restores scroll position BEFORE lazy loading so that the correct chunk is loaded first.
 */
// scrolling.js
export const SCROLL_KEY = "lastVisibleElement";

export function isValidContentElement(element) {
    // your validation code
}

// Create and export the observer
export const observer = new IntersectionObserver(
    (entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting && isValidContentElement(entry.target)) {
                console.log(`👀 Element is now visible: ${entry.target.id}`);
                saveScrollPosition(entry.target.id);
                break;
            }
        }
    },
    { rootMargin: "50px 0px 0px 0px", threshold: 0.1 }
);

// 🕵️‍♂️ Reattach observer to track visible elements
function reattachScrollObserver() {
    console.log("🔄 Reattaching scroll observer...");
    document.querySelectorAll("#main-content [id]").forEach(el => {
        if (isValidContentElement(el)) {
            console.log(`👀 Observing: ${el.id}`);
            observer.observe(el);
        }
    });
}

window.reattachScrollObserver = reattachScrollObserver;

// 🛑 Ensure we only track valid content nodes
function isValidContentElement(el) {
    // Exclude sentinels & non-content elements
    if (!el.id || el.id.includes("sentinel") || el.id.startsWith("toc-") || el.id === "ref-overlay") {
        console.log(`🚫 Skipping non-tracked element: ${el.id}`);
        return false;
    }
    return ["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "IMG"].includes(el.tagName);
}

window.isValidContentElement = isValidContentElement;

// 🛑 Clear scroll position on full refresh (optional)
window.addEventListener("beforeunload", () => {
    if (performance.navigation.type === 1) { // Full refresh detected
        console.log("🔄 Resetting scroll position due to full refresh.");
        sessionStorage.removeItem(SCROLL_KEY);
    }
});




// Handle navigation to specific ID or position
    let navigationTimeout;

    function handleNavigation() {
        clearTimeout(navigationTimeout);
        navigationTimeout = setTimeout(() => {
            const targetId = getTargetIdFromUrl();
            if (targetId) {
                console.log(`🔍 Handling navigation to: ${targetId}`);
                navigateToInternalId(targetId);
            }
        }, 300);
    }

    window.handleNavigation = handleNavigation;

    // Utility: Extract target `id` from the URL
    function getTargetIdFromUrl() {
        return window.location.hash ? window.location.hash.substring(1) : null;
    }

    window.getTargetIdFromUrl = getTargetIdFromUrl;

      // Utility: Check if an ID is numerical
    function isNumericId(id) {
        return /^\d+$/.test(id);
    }

    window.isNumericId = isNumericId;

    // Utility: Find a line for a numerical ID
    function findLineForNumericId(lineNumber, markdown) {
        const totalLines = markdown.split("\n").length;
        return Math.max(0, Math.min(lineNumber, totalLines - 1));
    }

    
    window.findLineForNumericId = findLineForNumericId;


    function findBlockForLine(lineNumber, allBlocks) {
      for (let i = 0; i < allBlocks.length; i++) {
        const block = allBlocks[i];
        const start = block.startLine;
        const end   = start + block.lines.length - 1;
        // If lineNumber is within [start..end]
        if (lineNumber >= start && lineNumber <= end) {
          return i; // i = index in allBlocks
        }
      }
      return -1; // not found
    }

    window.findBlockForLine = findBlockForLine;


function waitForElementAndScroll(targetId, maxAttempts = 10, attempt = 0) {
    const targetElement = document.getElementById(targetId);
    if (targetElement) {
        console.log(`✅ Target ID "${targetId}" found! Scrolling...`);
        setTimeout(() => {
            scrollElementIntoMainContent(targetElement, 50);
        }, 150);
        return;
    }

    if (attempt >= maxAttempts) {
        console.warn(`❌ Gave up waiting for "${targetId}".`);
        return;
    }

    setTimeout(() => waitForElementAndScroll(targetId, maxAttempts, attempt + 1), 200);
}


window.waitForElementAndScroll = waitForElementAndScroll;




// Utility: Find the line number of a unique `id` in the Markdown
    // Improved function to find an ID in the raw Markdown
   function findLineForCustomId(targetId) {
      // Iterate over all chunks and their blocks
      for (let chunk of window.nodeChunks) {
        for (let block of chunk.blocks) {
          // You can choose how to detect the custom ID.
          // For instance, if your block.content (or a rendered version) already includes
          // literal HTML tags with id="targetId", you could use a regex:
          const regex = new RegExp(`id=['"]${targetId}['"]`, "i");
          if (regex.test(block.content)) {
            // Return the start line for this block as the line number
            return block.startLine;
          }
        }
      }
      return null;
    }


window.findLineForCustomId = findLineForCustomId;



function navigateToInternalId(targetId) {
    if (window.isNavigatingToInternalId) {
        console.log("Navigation already in progress, skipping duplicate call.");
        return;
    }
    window.isNavigatingToInternalId = true;
    console.log(`🟢 Navigating to internal ID: ${targetId}`);

    if (!window.currentlyLoadedChunks) {
        window.currentlyLoadedChunks = new Set();
    }

    // First, check if target is already in DOM
    let existingElement = document.getElementById(targetId);
    if (existingElement) {
        scrollElementIntoMainContent(existingElement, 50);
        setTimeout(() => {
            scrollElementIntoMainContent(existingElement, 50);
            window.isNavigatingToInternalId = false;
        }, 600);
        return;
    }

    // Find target chunk
    let targetChunkIndex;
    if (isNumericId(targetId)) {
        targetChunkIndex = window.nodeChunks.findIndex(chunk =>
            chunk.blocks.some(block => block.startLine.toString() === targetId)
        );
    } else {
        let targetLine = findLineForCustomId(targetId);
        if (targetLine === null) {
            console.warn(`❌ No block found for target ID "${targetId}"`);
            window.isNavigatingToInternalId = false;
            return;
        }
        targetChunkIndex = window.nodeChunks.findIndex(chunk =>
            targetLine >= chunk.start_line && targetLine <= chunk.end_line
        );
    }

    if (targetChunkIndex === -1) {
        console.warn(`❌ No chunk found for target ID "${targetId}"`);
        window.isNavigatingToInternalId = false;
        return;
    }

    // Clear existing content
    const mainContentDiv = document.getElementById("main-content");
    mainContentDiv.innerHTML = '';
    window.currentlyLoadedChunks.clear();

    // Load contiguous block
    const startIndex = Math.max(0, targetChunkIndex - 1);
    const endIndex = Math.min(window.nodeChunks.length - 1, targetChunkIndex + 1);
    
    console.log(`Loading chunks ${startIndex} to ${endIndex}`);
    
    // Create an array to track loaded chunks for footnotes
    const loadedChunkIds = [];

    // Load chunks in order
    const loadChunksPromise = Promise.all(
        Array.from({ length: endIndex - startIndex + 1 }, (_, i) => {
            const chunkId = window.nodeChunks[startIndex + i].chunk_id;
            return new Promise(resolve => {
                loadChunk(chunkId, "down");
                loadedChunkIds.push(chunkId);
                resolve();
            });
        })
    );

    // After all chunks are loaded, inject footnotes and finish navigation
    loadChunksPromise.then(() => {
        console.log("All chunks loaded, injecting footnotes...");
        
        // Inject footnotes for all loaded chunks
        loadedChunkIds.forEach(chunkId => {
            console.log(`Injecting footnotes for chunk ${chunkId}`);
            injectFootnotesForChunk(chunkId);
        });

        // Reposition sentinels
        repositionFixedSentinelsForBlock();

        // Wait for footnotes to be injected before scrolling
        setTimeout(() => {
            waitForElementAndScroll(targetId);
            setTimeout(() => {
                let finalTarget = document.getElementById(targetId);
                if (finalTarget) {
                    scrollElementIntoMainContent(finalTarget, 50);
                }
                if (typeof attachMarkListeners === 'function') {
                    attachMarkListeners();
                }
                window.isNavigatingToInternalId = false;
            }, 400);
        }, 800);
    });
}



window.navigateToInternalId = navigateToInternalId;




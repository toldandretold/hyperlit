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
    
// footnotes buttons
const refContainer = document.getElementById("ref-container");
const refOverlay = document.getElementById("ref-overlay");
let isRefOpen = false;


// ============================================================
// Adjusting the Page Initialization
// ============================================================



async function loadMarkdownFile() {
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

            let footnotesFetched = false;
            try {
                let footnotesResponse = await fetch(window.jsonPath);
                if (footnotesResponse.ok) {
                    let footnotesData = await footnotesResponse.json();
                    await saveFootnotesToIndexedDB(footnotesData);
                    console.log("✅ Footnotes successfully saved to IndexedDB.");
                    window.footnotesData = footnotesData;
                    footnotesFetched = true;
                } else {
                    console.warn("⚠️ Failed to fetch footnotes JSON, using fallback.");
                }
            } catch (error) {
                console.error("❌ Error fetching footnotes JSON:", error);
            }

             // --- NEW LOGIC STARTS HERE: Check for existing nodeChunks.json ---
            let nodeChunksFetched = false;
            try {
                console.log("🔍 Checking if /markdown/"+book+"/nodeChunks.json is available...");
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

            window.savedChunks = { timestamp: serverTimestamp, chunks: [] };
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

        if (!window.footnotesData) {
            console.log("⚠️ No footnotes found in memory, checking IndexedDB...");
            let cachedFootnotes = await getFootnotesFromIndexedDB();
            if (cachedFootnotes) {
                console.log("✅ Using cached footnotes from IndexedDB.");
                window.footnotesData = cachedFootnotes;
            } else {
                console.log("⚠️ No valid footnotes found in IndexedDB. Fetching from server...");
                let footnotesResponse = await fetch(window.jsonPath);
                let footnotesData = await footnotesResponse.json();
                await saveFootnotesToIndexedDB(footnotesData);
                console.log("✅ Fetched and stored footnotes from server.");
                window.footnotesData = footnotesData;
            }
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


window.loadMarkdownFile = loadMarkdownFile;

async function saveFootnotesToIndexedDB(footnotesData) {
    let db = await initIndexedDB(); // ✅ Ensures DB is initialized

    return new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains("footnotes")) {
            console.warn("⚠️ Cannot save: 'footnotes' store missing.");
            return reject("Object store missing");
        }

        let transaction = db.transaction(["footnotes"], "readwrite");
        let store = transaction.objectStore("footnotes");

        let request = store.put({ id: "latest", data: footnotesData });
        request.onsuccess = () => resolve();
        request.onerror = () => reject("❌ Failed to save footnotes to IndexedDB");
    });
}

async function getFootnotesFromIndexedDB() {
    let db = await initIndexedDB(); // ✅ Ensures DB is initialized

    return new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains("footnotes")) {
            console.warn("⚠️ 'footnotes' object store still missing after initialization.");
            return resolve(null);
        }

        let transaction = db.transaction(["footnotes"], "readonly");
        let store = transaction.objectStore("footnotes");
        let getRequest = store.get("latest");

        getRequest.onsuccess = () => resolve(getRequest.result?.data || null);
        getRequest.onerror = () => resolve(null);
    });
}

window.getFootnotesFromIndexedDB = getFootnotesFromIndexedDB;

async function initIndexedDB() {
    return new Promise((resolve, reject) => {
        let request = indexedDB.open("MarkdownCache", 2); // ⬆️ Increment version to trigger upgrade

        request.onerror = () => reject("❌ IndexedDB Error");

        request.onupgradeneeded = (event) => {
            console.log("⚡ IndexedDB upgrade detected: Ensuring 'footnotes' store exists...");
            let db = event.target.result;

            // ✅ Create "footnotes" object store if missing
            if (!db.objectStoreNames.contains("footnotes")) {
                db.createObjectStore("footnotes", { keyPath: "id" });
                console.log("✅ Created 'footnotes' object store.");
            }
        };

        request.onsuccess = (event) => {
            console.log("✅ IndexedDB initialized successfully.");
            resolve(event.target.result);
        };
    });
}



async function clearIndexedDB() {
    try {
        let db = await openDatabase();
        let tx = db.transaction("nodeChunks", "readwrite");
        let store = tx.objectStore("nodeChunks");
        store.clear();
        return new Promise((resolve) => {
            tx.oncomplete = () => {
                console.log("🗑 IndexedDB `nodeChunks` cleared.");
                resolve();
            };
            tx.onerror = () => {
                console.error("❌ Error clearing IndexedDB.");
                resolve();
            };
        });
    } catch (error) {
        console.error("❌ Failed to clear IndexedDB:", error);
    }
}





/**
 * Restores scroll position BEFORE lazy loading so that the correct chunk is loaded first.
 */
const SCROLL_KEY = "lastVisibleElement";

// 🔍 Intersection Observer to track topmost visible element
const observer = new IntersectionObserver(
    (entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting && isValidContentElement(entry.target)) {
                console.log(`👀 Element is now visible: ${entry.target.id}`);
                saveScrollPosition(entry.target.id);
                break; // Save only the first visible element
            }
        }
    },
    { rootMargin: "50px 0px 0px 0px", threshold: 0.1 }
);

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





function reconstructSavedChunks() {
    if (!window.nodeChunks || window.nodeChunks.length === 0) {
        console.error("❌ No `nodeChunks` available to reconstruct `savedChunks`.");
        return;
    }

    // ✅ Ensure we use the latest server timestamp
    let latestServerTimestamp = localStorage.getItem("markdownLastModified") || Date.now().toString();

    let reconstructedChunks = window.nodeChunks.slice(0, 3).map(chunk => ({
        id: chunk.chunk_id,
        html: document.querySelector(`[data-chunk-id="${chunk.chunk_id}"]`)?.outerHTML || null
    })).filter(chunk => chunk.html); // Remove any null chunks

    let reconstructedSavedChunks = { 
        timestamp: latestServerTimestamp,  // ✅ Ensure we use the latest stored timestamp
        chunks: reconstructedChunks 
    };

    localStorage.setItem("savedChunks", JSON.stringify(reconstructedSavedChunks));

    console.log("✅ `savedChunks` successfully reconstructed and stored with timestamp:", latestServerTimestamp);
}








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

// 🛑 Ensure we only track valid content nodes
function isValidContentElement(el) {
    // Exclude sentinels & non-content elements
    if (!el.id || el.id.includes("sentinel") || el.id.startsWith("toc-") || el.id === "ref-overlay") {
        console.log(`🚫 Skipping non-tracked element: ${el.id}`);
        return false;
    }
    return ["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "IMG"].includes(el.tagName);
}

// 🛑 Clear scroll position on full refresh (optional)
window.addEventListener("beforeunload", () => {
    if (performance.navigation.type === 1) { // Full refresh detected
        console.log("🔄 Resetting scroll position due to full refresh.");
        sessionStorage.removeItem(SCROLL_KEY);
    }
});

// Markdown Conversion shit







function renderBlockToHtml(block) {

    let html = "";
    if (!block || !block.type || typeof block.content === "undefined") {
        console.error("❌ Invalid block detected:", block);
        return "";
    }

    // Ensure each block is wrapped in a div with data-block-id
    let blockWrapper = `<div data-block-id="${block.startLine}">`;

    if (block.type === "heading") {
        let headingTag = `h${block.level}`;
        html += `<${headingTag} id="${block.startLine}" data-block-id="${block.startLine}">${parseInlineMarkdown(block.content)}</${headingTag}>\n`;
    }
    else if (block.type === "blockquote") {
        html += `<blockquote data-block-id="${block.startLine}"><p id="${block.startLine}">${parseInlineMarkdown(block.content)}</p></blockquote>\n`;
    }
    else if (block.type === "image") {
        html += `<img id="${block.startLine}" data-block-id="${block.startLine}" src="${block.imageUrl}" alt="${block.altText}" />\n`;
    }
    else if (block.type === "paragraph") {
        // ✅ Ensure each paragraph gets an `id` based on its line number
        html += `<p id="${block.startLine}" data-block-id="${block.startLine}">${parseInlineMarkdown(block.content)}</p>\n`;
    }

    return blockWrapper + html + `</div>\n`;  // Close block wrapper
}

// Function to parse inline Markdown for italics, bold, and inline code
function parseInlineMarkdown(text) {
    text = text.replace(/\\([`*_{}\[\]()#+.!-])/g, "$1"); // Remove escape characters before processing
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"); // Convert **bold** to <strong>
    text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>"); // Convert *italic* to <em>
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>"); // Convert `code` to <code>
    
    // Convert Markdown links [text](url) to HTML <a> tags
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    return text;
}

    function convertMarkdownToHtml(markdown) {
        const lines = markdown.split("\n");
        let htmlOutput = "";

        lines.forEach((line) => {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith("# ")) {
                htmlOutput += `<h1>${parseInlineMarkdown(trimmedLine.replace(/^# /, ""))}</h1>`;
            } else if (trimmedLine.startsWith("## ")) {
                htmlOutput += `<h2>${parseInlineMarkdown(trimmedLine.replace(/^## /, ""))}</h2>`;
            } else if (trimmedLine.startsWith("### ")) {
                htmlOutput += `<h3>${parseInlineMarkdown(trimmedLine.replace(/^### /, ""))}</h3>`;
            } else if (trimmedLine.startsWith(">")) {
                htmlOutput += `<blockquote>${parseInlineMarkdown(trimmedLine.replace(/^> /, ""))}</blockquote>`;
            } else if (trimmedLine.match(/^!\[.*\]\(.*\)$/)) {
                const imageMatch = trimmedLine.match(/^!\[(.*)\]\((.*)\)$/);
                if (imageMatch) {
                    const altText = imageMatch[1];
                    const imageUrl = imageMatch[2];
                    htmlOutput += `<img src="${imageUrl}" alt="${altText}"/>`;
                }
            } else if (trimmedLine) {
                htmlOutput += `<p>${parseInlineMarkdown(trimmedLine)}</p>`;
            }
        });

        return htmlOutput;
    }



// TOC shit // 
// Function to generate and display the Table of Contents

async function generateTableOfContents(tocContainerId, toggleButtonId) {
  try {
    console.log("📖 Generating Table of Contents...");

    // ✅ Check if footnotes data is already loaded
    let sections = window.footnotesData;

    // ✅ Try to load from IndexedDB if not in memory
    if (!sections) {
      console.log("⚠️ No footnotes in memory, checking IndexedDB...");
      sections = await getFootnotesFromIndexedDB();
    }

    // ✅ Fetch from the server as a last resort
    if (!sections) {
      console.log("🌍 Fetching footnotes from server...");
      
      // Get the last stored timestamp (or default to 0 if missing)
      const storedFootnotesTimestamp = localStorage.getItem("footnotesLastModified") || "0";
      
      // Build the URL with the timestamp to bypass cache
      const freshJsonUrl = window.getFreshUrl(`/markdown/${book}/main-text-footnotes.json`, storedFootnotesTimestamp);
      console.log(`🔗 Fetching footnotes from: ${freshJsonUrl}`);

      // Fetch the latest footnotes JSON
      const response = await fetch(freshJsonUrl);
      sections = await response.json();
      
      // Save footnotes to IndexedDB for faster future loads
      await saveFootnotesToIndexedDB(sections);
      
      // Cache in memory for immediate use
      window.footnotesData = sections;
    }

    // ✅ At this point, `sections` contains the footnotes JSON
    console.log(`✅ Loaded footnotes, processing TOC...`);

    const tocContainer = document.getElementById(tocContainerId);
    if (!tocContainer) {
      console.error(`❌ TOC container with ID "${tocContainerId}" not found.`);
      return;
    }

    tocContainer.innerHTML = ""; // Clear previous TOC content

    let firstHeadingAdded = false;

    sections.forEach((section) => {
      if (section.heading) {
        const headingContent = Object.values(section.heading)[0]; // Get the heading text
        const headingLevel = Object.keys(section.heading)[0]; // Get the heading level (e.g., h1, h2)
        const lineNumber = section.heading.line_number; // Get the line number

        if (headingContent && headingLevel && lineNumber) {
          // Convert Markdown to inline HTML for heading content
          const headingHtml = parseInlineMarkdown(headingContent);

          // Create the heading element dynamically (e.g., <h1>, <h2>)
          const headingElement = document.createElement(headingLevel);
          headingElement.innerHTML = headingHtml;

          // Add the "first" class to the first heading
          if (!firstHeadingAdded) {
            headingElement.classList.add("first");
            firstHeadingAdded = true;
          }

          // Create a link wrapping the heading
          const link = document.createElement("a");
          link.href = `#${lineNumber}`;
          link.appendChild(headingElement);

          // Create a container for the link
          const tocItem = document.createElement("div");
          tocItem.classList.add("toc-item", headingLevel); // Optional: Add class for styling
          tocItem.appendChild(link);

          // Append the container to the TOC
          tocContainer.appendChild(tocItem);
        }
      }
    });

    // ✅ Add a toggle button to show/hide the TOC
    const toggleButton = document.getElementById(toggleButtonId);
    if (toggleButton) {
      toggleButton.addEventListener("click", () => {
        tocContainer.classList.toggle("hidden");
      });
    }

  } catch (error) {
    console.error("❌ Error generating Table of Contents:", error);
  }
}




// CHUNKY CHUNKY
// ============================================================
// Fixed Sentinel Setup for a Contiguous Block
// ============================================================

function initializeLazyLoadingFixed() {
    // Initial checks
    if (!window.nodeChunks || window.nodeChunks.length === 0) {
        console.error("🚨 nodeChunks is empty! Aborting lazy loading initialization.");
        return;
    }

    if (window.isRestoringFromCache) {
        console.log("🚀 Skipping lazy loading because cached chunks were restored.");
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
function getLastChunkId() {
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


function loadChunk(chunkId, direction = "down") {
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

    if (typeof attachMarkListeners === 'function') {
        console.log(`🎯 Attaching mark listeners to chunk ${chunkId}`);
        attachMarkListeners();
    }
    
    // If this is the first chunk (chunkId === 0), make sure sentinels are properly positioned
    if (chunkId === 0) {
        repositionFixedSentinelsForBlock();
    }

    injectFootnotesForChunk(chunkId);

    console.log(`✅ Chunk ${chunkId} loaded successfully.`);
}


     // [:FOOTNOTES]

    /**
     * We need to prevent lazy loading while doing footnotes, as the footnotes alters dom, and thefore acts as a scroll event that 
     * To prevent lazy loading from triggering when footnotes are injected, you need to:
        * Temporarily disable lazy loading (window.isUpdatingJsonContent = true).
        * Inject footnotes as usual.
        *Re-enable lazy loading (window.isUpdatingJsonContent = false) after updates.
        */

       /**
 * Injects footnotes for a given chunk.
 * This function retrieves the chunk data (including its start and end lines)
 * and then applies footnotes that fall within that range.
 *
 * @param {number} chunkId - The ID of the chunk to process.
 * @param {string} jsonPath - Path to the JSON file containing footnotes.
 */
async function injectFootnotesForChunk(chunkId) {
  // Temporarily disable lazy loading
  window.isUpdatingJsonContent = true;
  console.log("⏳ Disabling lazy loading while updating footnotes...");

  // Look up the chunk data by chunkId.
  const chunk = window.nodeChunks.find(c => c.chunk_id === chunkId);
  if (!chunk) {
    console.error(`❌ Chunk with ID ${chunkId} not found.`);
    window.isUpdatingJsonContent = false;
    return;
  }

  // Use the chunk’s start and end line numbers.
  const startLine = chunk.start_line;
  const endLine = chunk.end_line;

  try {
    // ✅ Check memory cache first
    let sections = window.footnotesData;

    // ✅ Try IndexedDB if missing
    if (!sections) {
      console.log("⚠️ No footnotes in memory, checking IndexedDB...");
      sections = await getFootnotesFromIndexedDB();
    }

    // ✅ Fetch from the server if still missing
    if (!sections) {
      console.log("🌍 Fetching footnotes from server...");

      // Get last stored timestamp (or default to 0)
      const storedFootnotesTimestamp = localStorage.getItem("footnotesLastModified") || "0";
      
      // Construct URL with timestamp to avoid cache issues
      const freshJsonUrl = window.getFreshUrl(`/markdown/${book}/main-text-footnotes.json`, storedFootnotesTimestamp);
      console.log(`🔗 Fetching footnotes from: ${freshJsonUrl}`);

      const response = await fetch(freshJsonUrl);
      sections = await response.json();
      
      // ✅ Save fetched footnotes to IndexedDB for future use
      await saveFootnotesToIndexedDB(sections);
      
      // ✅ Cache in memory for immediate access
      window.footnotesData = sections;
    }

    // ✅ Now we have the footnotes in `sections`
    console.log("✅ Footnotes data loaded, injecting footnotes...");

    sections.forEach((section) => {
      if (section.footnotes) {
        Object.entries(section.footnotes).forEach(([key, footnote]) => {
          const { line_number, content } = footnote;

          // Process only if the footnote’s line number is within this chunk’s range.
          if (line_number >= startLine && line_number <= endLine) {
            const targetElement = document.getElementById(line_number.toString());
            if (targetElement) {
              // Avoid duplicate injection.
              if (targetElement.innerHTML.includes(`<sup class="note" data-note-key="${key}">`)) {
                console.log(`Footnote ${key} already processed in chunk ${chunkId}. Skipping.`);
                return;
              }

              // Construct a regex to find the Markdown footnote reference.
              const regex = new RegExp(`\\[\\^${key}\\](?!:)`, "g");
              if (regex.test(targetElement.innerHTML)) {
                // Convert Markdown footnote content to HTML.
                const footnoteHtml = content ? convertMarkdownToHtml(content) : "";

                // Replace the Markdown footnote marker with a <sup> element.
                targetElement.innerHTML = targetElement.innerHTML.replace(
                  regex,
                  `<sup class="note" data-note-key="${key}">[^${key}]</sup>`
                );
              } else {
                console.warn(`Regex did not match for footnote key: ${key} in element:`, targetElement.innerHTML);
              }
            } else {
              console.warn(`No target element found for line_number: ${line_number} in chunk ${chunkId}`);
            }
          }
        });
      }
    });

    // ✅ Re-enable lazy loading after footnotes update
    setTimeout(() => {
      window.isUpdatingJsonContent = false;
      console.log("✅ Re-enabling lazy loading after footnotes update.");
    }, 200); // Delay ensures any layout shifts settle

  } catch (error) {
    console.error("❌ Error injecting footnotes for chunk:", error);
    window.isUpdatingJsonContent = false;
  }
}






         // Function to update the footnotes container state
        function updateRefState() {
            if (isRefOpen) {
                console.log("Opening footnotes container...");
                refContainer.classList.add("open");
                refOverlay.classList.add("active");
            } else {
                console.log("Closing footnotes container...");
                refContainer.classList.remove("open");
                refOverlay.classList.remove("active");
            }
        }

        // Function to fetch footnotes from memory, IndexedDB, or server
async function fetchFootnotes() {
    try {
        // ✅ 1. Check if footnotes are already loaded in memory
        if (window.footnotesData) {
            console.log("✅ Using cached footnotes from memory.");
            return window.footnotesData;
        }

        // ✅ 2. Try to load footnotes from IndexedDB
        console.log("⚠️ No footnotes in memory, checking IndexedDB...");
        let footnotes = await getFootnotesFromIndexedDB();
        if (footnotes) {
            console.log("✅ Loaded footnotes from IndexedDB.");
            window.footnotesData = footnotes; // Cache in memory for next time
            return footnotes;
        }

        // ✅ 3. Fetch footnotes from the server as a last resort
        console.log("🌍 Fetching footnotes from server...");

        // Get last stored timestamp (or default to 0)
        const storedFootnotesTimestamp = localStorage.getItem("footnotesLastModified") || "0";

        // Construct URL with timestamp to bypass cache
        const freshJsonUrl = window.getFreshUrl(`/markdown/${book}/main-text-footnotes.json`, storedFootnotesTimestamp);
        console.log(`🔗 Fetching footnotes from: ${freshJsonUrl}`);

        const response = await fetch(freshJsonUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch footnotes JSON: ${response.statusText}`);
        }

        // ✅ Parse footnotes JSON
        footnotes = await response.json();

        // ✅ Store fetched footnotes in IndexedDB for future use
        await saveFootnotesToIndexedDB(footnotes);

        // ✅ Cache footnotes in memory for fast access
        window.footnotesData = footnotes;

        console.log("✅ Successfully fetched and stored footnotes.");
        return footnotes;
    } catch (error) {
        console.error("❌ Error fetching footnotes JSON:", error);
        return null;
    }
}


        // Function to open the footnotes container with content
        function openReferenceContainer(content) {
                console.log("Opening reference container with content:", content); // Debugging output
            if (refContainer) {
                if (refContainer) {
                    refContainer.innerHTML = content; // Populate the container
                    isRefOpen = true;
                    updateRefState();
                }
            }
        }

        // Function to close the reference container
            function closeReferenceContainer() {
                    isRefOpen = false;
                updateRefState();
                setTimeout(() => {
                    refContainer.innerHTML = ""; // Clear content after animation
                }, 300); // Delay to match the slide-out animation
            }

            console.log("convertMarkdownToHtml function:", typeof convertMarkdownToHtml);

            async function displayFootnote(noteElement) {
                const noteKey = noteElement.dataset.noteKey;
                const parentId = noteElement.closest("[id]")?.id;

                console.log("Note key:", noteKey);
                console.log("Parent ID:", parentId);


                if (!noteKey || !parentId) {
                    console.warn("Missing note key or parent ID for the clicked footnote.");
                    return;
                }

                const footnotesData = await fetchFootnotes();
                if (!footnotesData) {
                    console.error("Footnotes data could not be fetched.");
                    return;
                }

                console.log("Fetched footnotes data:", footnotesData);

                // Locate the correct section and footnote
                const section = footnotesData.find((sec) =>
                    Object.values(sec.footnotes || {}).some(
                        (footnote) => footnote.line_number.toString() === parentId && footnote.content
                    )
                );

                console.log("Matched section:", section);

                if (!section) {
                    console.warn(`No matching section found for line ${parentId}.`);
                    return;
                }

                const footnote = section.footnotes[noteKey];
                console.log("Matched footnote:", footnote);

                if (!footnote || footnote.line_number.toString() !== parentId) {
                    console.warn(`Footnote [${noteKey}] not found at line ${parentId}.`);
                    return;
                }

                console.log("Footnote content before conversion:", footnote.content);
                // Convert the Markdown content to HTML
                const footnoteHtml = convertMarkdownToHtml(footnote.content);
                console.log("Converted HTML:", footnoteHtml);

                // Display the content in the reference container
                console.log("Opening reference container with content:", `<div class="footnote-content">${footnoteHtml}</div>`);
                openReferenceContainer(`<div class="footnote-content">${footnoteHtml}</div>`);
            }


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


    // Utility: Extract target `id` from the URL
    function getTargetIdFromUrl() {
        return window.location.hash ? window.location.hash.substring(1) : null;
    }


      // Utility: Check if an ID is numerical
    function isNumericId(id) {
        return /^\d+$/.test(id);
    }

    // Utility: Find a line for a numerical ID
    function findLineForNumericId(lineNumber, markdown) {
        const totalLines = markdown.split("\n").length;
        return Math.max(0, Math.min(lineNumber, totalLines - 1));
    }

    



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
    
    // Load chunks in order
    for (let i = startIndex; i <= endIndex; i++) {
        loadChunk(window.nodeChunks[i].chunk_id, "down");
    }

    // Reposition sentinels
    repositionFixedSentinelsForBlock();

    // Wait for content to load and scroll
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
function repositionFixedSentinelsForBlock() {
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



// WELLLLLLllllllllllllllllllllllllllllllllllllllllllllllllllllllllll
// WELLLLLLllllllllllllllllllllllllllllllllllllllllllllllllllllllllll
// WELLLLLLllllllllllllllllllllllllllllllllllllllllllllllllllllllllll
// WELLLLLLllllllllllllllllllllllllllllllllllllllllllllllllllllllllll
// WELLLLLLllllllllllllllllllllllllllllllllllllllllllllllllllllllllll
// WELLLLLLllllllllllllllllllllllllllllllllllllllllllllllllllllllllll
// WELLLLLLllllllllllllllllllllllllllllllllllllllllllllllllllllllllll


document.addEventListener("DOMContentLoaded", async () => {

    const mainContentDiv = document.getElementById("main-content"); // This already exists
    window.mainContentDiv = mainContentDiv;
    window.markdownContent = ""; // Store Markdown globally

    // Utility function to bust the cache using a lastModified timestamp
    window.getFreshUrl = function(url, lastModified) {
      return `${url}?v=${lastModified}`;
    };
    window.mdFilePath = `/markdown/${book}/main-text.md`;  // Path to raw MD file

    window.isNavigatingToInternalId = false;

    console.log("✅ DOM is ready. Loading Markdown file...");

    // ✅ Initialize IndexedDB
    window.db = await openDatabase();
    console.log("✅ IndexedDB initialized.");

    // ✅ Load main Markdown file
    await loadMarkdownFile();

    console.log("🔄 Checking for saved scroll position or internal link before lazy loading...");
    restoreScrollPosition();

    if (typeof attachMarkListeners === 'function') {
        console.log('🎯 Initial attachment of mark listeners');
        attachMarkListeners();
    }

    // ✅ Attach observer to content elements
    document.querySelectorAll("#main-content [id]").forEach((el) => {
        if (isValidContentElement(el)) observer.observe(el);
    });

    // ✅ Load Table of Contents
    generateTableOfContents("toc-container", "toc-toggle-button");

    // ✅ TOC Handling
    const tocContainer = document.getElementById("toc-container");
    const tocOverlay = document.getElementById("toc-overlay");
    const tocButton = document.getElementById("toc-toggle-button");
    
    if (!tocContainer || !tocOverlay || !tocButton) {
        console.error("TOC elements are missing in the DOM.");
        return;
    }

    let isTOCOpen = false;
    function updateTOCState() {
        if (isTOCOpen) {
            console.log("Opening TOC...");
            tocContainer.classList.add("open");
            tocOverlay.classList.add("active");
        } else {
            console.log("Closing TOC...");
            tocContainer.classList.remove("open");
            tocOverlay.classList.remove("active");
        }
    }

    tocButton.addEventListener("click", () => {
        isTOCOpen = !isTOCOpen;
        updateTOCState();
    });

    tocOverlay.addEventListener("click", () => {
        if (isTOCOpen) {
            isTOCOpen = false;
            updateTOCState();
        }
    });

    tocContainer.addEventListener("click", (event) => {
        const link = event.target.closest("a");
        if (link) {
            event.preventDefault();
            isTOCOpen = false;
            updateTOCState();
            const targetId = link.hash?.substring(1);
            if (!targetId) return;
            console.log(`📌 Navigating via TOC to: ${targetId}`);
            navigateToInternalId(targetId);
            setTimeout(() => {
                console.log(`🔄 Reattaching scroll observer after TOC navigation...`);
                reattachScrollObserver();
            }, 600);
        }
    });

    // ✅ Internal Link Navigation Handling
    document.addEventListener("click", (event) => {
        const link = event.target.closest("a");
        if (link && link.hash && link.hash.startsWith("#")) {
            event.preventDefault();
            const targetId = link.hash.substring(1);
            navigateToInternalId(targetId);
        }
    });

    // ✅ Footnotes Click Handling (Replaces `jsonPath`)
    document.addEventListener("click", async (event) => {
        const noteElement = event.target.closest("sup.note");
        if (noteElement) {
            event.preventDefault();
            const noteKey = noteElement.dataset.noteKey;
            const parentId = noteElement.closest("[id]")?.id;
            if (!noteKey || !parentId) {
                console.warn("Missing note key or parent ID for footnote.");
                return;
            }

            // ✅ Load footnotes from memory, IndexedDB, or fetch from server
            let footnotesData = window.footnotesData || await getFootnotesFromIndexedDB();
            
            if (!footnotesData) {
                console.log("🌍 Fetching footnotes from server...");
                const storedFootnotesTimestamp = localStorage.getItem("footnotesLastModified") || "0";
                const freshJsonUrl = window.getFreshUrl(`/markdown/${book}/main-text-footnotes.json`, storedFootnotesTimestamp);
                const response = await fetch(freshJsonUrl);
                footnotesData = await response.json();
                await saveFootnotesToIndexedDB(footnotesData);
                window.footnotesData = footnotesData;
            }

            // ✅ Search for the footnote within the retrieved data
            const section = footnotesData.find((sec) =>
                Object.values(sec.footnotes || {}).some(
                    (fn) => fn.line_number.toString() === parentId && fn.content
                )
            );

            if (!section) {
                console.warn(`No matching section found for line ${parentId}.`);
                return;
            }

            const footnote = section.footnotes[noteKey];
            if (!footnote || footnote.line_number.toString() !== parentId) {
                console.warn(`Footnote [${noteKey}] not found at line ${parentId}.`);
                return;
            }

            const footnoteHtml = convertMarkdownToHtml(footnote.content);
            openReferenceContainer(`<div class="footnote-content">${footnoteHtml}</div>`);
        }
    });

    // ✅ Footnotes Overlay Close Handler
    refOverlay.addEventListener("click", () => {
        if (isRefOpen) {
            console.log("Closing footnotes container via overlay click...");
            closeReferenceContainer();
        }
    });

    // ✅ Detect Navigation Type
    const navEntry = performance.getEntriesByType("navigation")[0] || {};
    const navType = navEntry.type || "navigate";

    if (navType === "reload") {
        console.log("🔄 Page refreshed (F5 or Ctrl+R).");
    } else if (navType === "back_forward") {
        console.log("⬅️➡️ Navigation via Back/Forward buttons.");
    } else {
        console.log("🔗 Entered page via direct URL or new tab.");
    }

    handleNavigation();
});






